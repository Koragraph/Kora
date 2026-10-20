// withGraphWorkers — a GraphService whose blocking members (callTool / status / brief) run in a small pool of
// worker_threads (see worker.ts), so the runtime's event loop never waits on SQLite or on the git calls the
// worktree overlay makes. Everything else (ingest — already a child process; repoRoot — a cached git call) stays
// on the inline service.
//
// Failure model: a worker that cannot start (no dist, no native binding in this Node) makes the proxy fall back
// to the inline service, with one log line — the graph keeps working, only the stall protection is lost — and the
// start is retried after a backoff (30 s, doubling to 10 min): one failed start (a dist rebuild in progress, a
// transient EMFILE) used to leave every later query blocking the daemon's loop for good (audit 2026-10-15 #8). A worker that dies mid-flight fails ITS pending calls with a clear error and is replaced on the next
// call. Every call is bounded by a timeout so a wedged query cannot hold a caller forever.
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { GraphService, GraphToolResult } from './index';
import { GraphToolError } from './service';
import { log } from '../server/log';

export const GRAPH_WORKERS = Math.max(1, Math.min(4, Number(process.env.KORA_GRAPH_WORKERS || 2)));
const CALL_TIMEOUT_MS = 240_000;   // the merge gate fans out many queries on a cold repo
const LIGHT_TIMEOUT_MS = 30_000;   // status / brief

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
interface Slot { worker: Worker | null; pending: Map<number, Pending>; starting: Promise<Worker> | null; failed: boolean }

export function withGraphWorkers(inline: GraphService, opts: { size?: number; scriptPath?: string; callTimeoutMs?: number; lightTimeoutMs?: number; retryMs?: number } = {}): GraphService {
  const size = opts.size ?? GRAPH_WORKERS;
  const script = opts.scriptPath ?? path.join(__dirname, 'worker.js');
  const slots: Slot[] = Array.from({ length: size }, () => ({ worker: null, pending: new Map(), starting: null, failed: false }));
  let seq = 0;
  let disabledUntil = 0; // inline until then (a worker failed to start); retried after it
  let startFailures = 0;
  const retryBaseMs = opts.retryMs ?? 30_000;

  function start(slot: Slot): Promise<Worker> {
    if (slot.worker) return Promise.resolve(slot.worker);
    if (slot.starting) return slot.starting;
    slot.starting = new Promise<Worker>((resolve, reject) => {
      let w: Worker;
      try { w = new Worker(script, { env: process.env as NodeJS.ProcessEnv }); }
      catch (e) { slot.starting = null; reject(e); return; }
      const onReady = (m: any) => {
        // Ready: hand over, and only now let the worker stop holding the loop open (a caller waiting on start() has
        // nothing else keeping the process alive — measured: node:test cancelled both offload tests with "Promise
        // resolution is still pending but the event loop has already resolved" because the unref happened first).
        if (m && m.ready) { w.off('message', onReady); slot.worker = w; slot.starting = null; if (slot.pending.size === 0) w.unref(); resolve(w); }
      };
      w.on('message', onReady);
      w.on('message', (m: any) => {
        if (!m || typeof m.id !== 'number') return;
        const p = slot.pending.get(m.id); if (!p) return;
        slot.pending.delete(m.id); clearTimeout(p.timer);
        if (m.ok) p.resolve(m.result);
        else if (m.error?.retry) {
          // This thread is done (its store changed under it): take it out of rotation NOW so the retry reaches a new one.
          if (slot.worker === w) { slot.worker = null; void w.terminate(); }
          p.reject(Object.assign(new Error(m.error.message), { retry: true }));
        }
        else p.reject(m.error?.graphToolError ? new GraphToolError(m.error.message, m.error.code, m.error.data ?? undefined) : new Error(m.error?.message ?? 'graph worker error'));
      });
      const die = (why: string) => {
        if (slot.worker === w) slot.worker = null;
        if (slot.starting) { slot.starting = null; reject(new Error(why)); }
        // Calls still queued on a thread that went away are retried once on its replacement (reads are idempotent).
        for (const [, p] of slot.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error(`graph worker ${why}`), { retry: true })); }
        slot.pending.clear();
      };
      w.on('error', (e) => { log('graph worker error', e); die(`failed: ${e?.message ?? e}`); });
      w.on('exit', (code) => { if (code !== 0) log(`graph worker exited with code ${code}`); die(`exited (${code})`); });
      // (ref'd while starting; unref'd once ready with nothing pending, and again whenever the pending set drains —
      // a worker must never keep the process alive on its own, but it must keep it alive for a caller.)
    });
    return slot.starting;
  }

  function pick(): Slot {
    let best = slots[0];
    for (const s of slots) if (s.pending.size < best.pending.size) best = s;
    return best;
  }

  // Reads are idempotent: a call the worker bounced because the store file changed under it is sent once more (to the
  // fresh thread that replaces it).
  async function send<T>(msg: Record<string, unknown>, timeoutMs: number, fallback: () => Promise<T>): Promise<T> {
    try { return await sendOnce<T>(msg, timeoutMs, fallback); }
    catch (e: any) { if (e?.retry) return sendOnce<T>(msg, timeoutMs, fallback); throw e; }
  }
  async function sendOnce<T>(msg: Record<string, unknown>, timeoutMs: number, fallback: () => Promise<T>): Promise<T> {
    if (Date.now() < disabledUntil) return fallback();
    const slot = pick();
    let w: Worker;
    try { w = await start(slot); startFailures = 0; }
    catch (e) {
      // Cannot run workers right now: stay inline for a while, then try again.
      const wait = Math.min(retryBaseMs * 2 ** startFailures, 20 * retryBaseMs);
      startFailures++; disabledUntil = Date.now() + wait;
      log(`graph workers unavailable (${(e as Error)?.message ?? e}); graph queries run inline, retrying in ${Math.round(wait / 1000)} s`);
      return fallback();
    }
    const id = ++seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.pending.delete(id);
        reject(new Error(`graph ${String(msg.op)} timed out after ${timeoutMs}ms`));
        // A timed-out call means this thread is stuck in a synchronous query: every call queued behind it would only
        // wait too (the pool kept feeding a wedged thread, 2026-10-14 audit). Take it out of rotation now, move its other
        // callers to a fresh thread, and let the stuck one die when its native call returns.
        if (slot.worker === w) {
          log(`graph worker: ${String(msg.op)} timed out after ${timeoutMs}ms; replacing the thread`);
          slot.worker = null;
          for (const [pid, p] of slot.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('graph worker replaced after a timeout'), { retry: true })); slot.pending.delete(pid); }
          void w.terminate();
        }
      }, timeoutMs);
      timer.unref();
      slot.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      w.ref(); // keep the process alive while something is in flight
      w.postMessage({ id, ...msg });
    }).finally(() => { if (slot.pending.size === 0 && slot.worker) slot.worker.unref(); });
  }

  const proxy: GraphService = {
    ...inline,
    callTool: (name, args, o) => send<GraphToolResult>({ op: 'callTool', name, args, opts: { cwd: o.cwd, ...(o.fresh !== undefined ? { fresh: o.fresh } : {}) } }, (opts.callTimeoutMs ?? CALL_TIMEOUT_MS), () => inline.callTool(name, args, o)),
    // opts (nocache) cross the thread boundary: dropped, a "re-read after the catch-up finished" got the 10 s-old answer.
    status: (cwd, o) => send({ op: 'status', cwd, ...(o?.nocache ? { nocache: true } : {}) }, (opts.lightTimeoutMs ?? LIGHT_TIMEOUT_MS), () => inline.status(cwd, o)),
    fuzzy: (prompt, root, generation) => send<unknown[]>({ op: 'fuzzy', prompt, root, generation }, (opts.lightTimeoutMs ?? LIGHT_TIMEOUT_MS), async () => require('./fuzzy').fuzzyForPrompt(prompt, root, generation)),
    bugLocalize: (prompt, root, generation) => send<unknown>({ op: 'bugLocalize', prompt, root, generation }, (opts.lightTimeoutMs ?? LIGHT_TIMEOUT_MS), async () => require('./bug-localize').localizeBug(prompt, root, generation)),
    brief: (cwd, agent) => send<string>({ op: 'brief', cwd, ...(agent ? { agent } : {}) }, (opts.lightTimeoutMs ?? LIGHT_TIMEOUT_MS), () => inline.brief(cwd, agent)),
  };
  (proxy as any).__workers = { size, get live() { return slots.filter((s) => s.worker).length; }, get disabled() { return Date.now() < disabledUntil; } };
  return proxy;
}
