// The daemon's hard stall watchdog. startStallDetector (daemon.ts) only LOGS a stall after it ends; a stall that never
// ends (2026-10-14: a graph query pinned the main thread at 98% CPU for an hour, the desktop app could not open) needs
// something OUTSIDE the main thread. A worker thread watches a heartbeat the main thread stamps every second into a
// SharedArrayBuffer; when the main loop has not run for `stallMs` (default 60 s, KORA_WATCHDOG_MS, 0 = off) the worker
// writes one clear line to server.log (synchronously, with the last HTTP route / RPC the daemon started) and SIGKILLs
// the process so the app's supervisor (apps/desktop daemon attach, kora-runtime.sh ensure) starts a fresh one.
//
// Monotonic time (process.hrtime), so a sleeping Mac is not a stall; the worker's own timers are unaffected by a blocked
// main thread. The "last request" label is written by noteWatchdogLabel (RPC dispatch) and, through a global hook, by the
// ui-server's HTTP/WS guard (packages/ui-server/src/currentRequest.ts).
import { Worker } from 'node:worker_threads';
import { logPath } from './log';

const LABEL_BYTES = 512;
const HOOK = Symbol.for('kora.currentRequestHook');

let labelView: Uint8Array | null = null;
const enc = new TextEncoder();

/** Remember what the daemon is about to do (cheap; no-op until the watchdog runs). */
export function noteWatchdogLabel(label: string): void {
  if (!labelView) return;
  const bytes = enc.encode(label.slice(0, 200));
  const n = Math.min(bytes.length, LABEL_BYTES - 1);
  labelView.set(bytes.subarray(0, n), 0);
  labelView[n] = 0;
}

export function watchdogMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KORA_WATCHDOG_MS;
  if (raw === undefined || raw === '') return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const hb = new BigInt64Array(workerData.sab, 0, 1);
const label = new Uint8Array(workerData.sab, 8, ${LABEL_BYTES});
const stallMs = BigInt(workerData.stallMs);
setInterval(() => {
  const last = Atomics.load(hb, 0);
  if (last === 0n) return;
  const lagMs = (process.hrtime.bigint() - last) / 1000000n;
  if (lagMs < stallMs) return;
  let end = 0; while (end < label.length && label[end] !== 0) end++;
  const what = Buffer.from(label.subarray(0, end)).toString('utf8') || 'unknown';
  const line = new Date().toISOString() + ' WATCHDOG: the daemon main thread has not run for ' + lagMs + ' ms (last request: ' + what + '); killing pid ' + workerData.pid + ' so it is restarted';
  try { fs.appendFileSync(workerData.logFile, line + '\\n'); } catch {}
  try { fs.writeSync(2, line + '\\n'); } catch {}
  process.kill(workerData.pid, 'SIGKILL');
}, workerData.tickMs);
`;

/** Start the watchdog. Returns a stop function. A `stallMs` of 0 disables it. */
export function startWatchdog(opts: { stallMs?: number; tickMs?: number; logFile?: string } = {}): () => void {
  const stallMs = opts.stallMs ?? watchdogMsFromEnv();
  if (stallMs <= 0) return () => {};
  const sab = new SharedArrayBuffer(8 + LABEL_BYTES);
  labelView = new Uint8Array(sab, 8, LABEL_BYTES);
  const hb = new BigInt64Array(sab, 0, 1);
  const beat = () => Atomics.store(hb, 0, process.hrtime.bigint());
  beat();
  (globalThis as Record<symbol, unknown>)[HOOK] = noteWatchdogLabel;
  const timer = setInterval(beat, 1000);
  timer.unref();
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { sab, stallMs, tickMs: opts.tickMs ?? 2000, pid: process.pid, logFile: opts.logFile ?? logPath() },
  });
  worker.unref();
  worker.on('error', () => { /* the watchdog must never take the daemon down by itself */ });
  return () => {
    clearInterval(timer);
    delete (globalThis as Record<symbol, unknown>)[HOOK];
    labelView = null;
    void worker.terminate();
  };
}
