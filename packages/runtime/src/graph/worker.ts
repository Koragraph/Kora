// Graph worker thread — the koragraph store (better-sqlite3, synchronous by construction) answered from OFF the
// runtime's event loop. Every query the runtime used to run inline — explore / neighbours / file_symbols for a
// pane, the merge gate's fan-out, per-prompt declaration injection, the session brief, status polls — is a
// synchronous stretch on a 2.5 GB database; measured 2–9 s stalls, during which every websocket client missed
// its pings and dropped ("kora is reconnecting"). Here the same GraphService runs in a worker_thread with its
// own connection; the main thread only ever awaits a message. See offload.ts for the pool.
import { parentPort } from 'node:worker_threads';
import { createGraphService, GraphToolError } from './service';
import fs from 'node:fs';
import { isStoreCorruptError, graphDbPath } from './embedded';

// The koragraph connection is opened once per thread and follows the FILE it opened: a store moved aside (damaged)
// or deleted and rebuilt while the daemon runs kept answering from the old inode until a restart. The thread notes the
// store's inode and, when it changes, asks the caller to retry and makes way for a fresh thread.
function storeIno(): number | null { try { return fs.statSync(graphDbPath()).ino; } catch { return null; } }
let ino: number | null = storeIno();

type Req =
  | { id: number; op: 'callTool'; name: string; args: Record<string, unknown>; opts: { cwd: string; fresh?: boolean } }
  | { id: number; op: 'status'; cwd: string; nocache?: boolean }
  | { id: number; op: 'brief'; cwd: string; agent?: string }
  | { id: number; op: 'fuzzy'; prompt: string; root: string; generation: string }
  | { id: number; op: 'bugLocalize'; prompt: string; root: string; generation: string };

const port = parentPort;
if (!port) throw new Error('graph worker must run as a worker_thread');
// The lexical channel's default 1.5 s deadline made every cold prose explore come back PARTIAL (no lexical answer), which the
// injection then discards. This thread runs off the event loop, so it can afford to wait; the caller's own budget
// (injectForPrompt's 7 s, withTimeout) still bounds the turn. An explicit env value wins.
process.env.RETRIEVAL_LEXICAL_TIMEOUT_MS ??= '3500';
const svc = createGraphService();

port.on('message', async (m: Req) => {
  const now = storeIno();
  if (ino !== null && now !== null && now !== ino) {
    port.postMessage({ id: m.id, ok: false, error: { message: 'the graph store was replaced; retrying on a fresh graph worker', code: 'store_replaced', data: null, graphToolError: false, retry: true } });
    setTimeout(() => process.exit(1), 20);
    return;
  }
  if (ino === null) ino = now;
  try {
    let result: unknown;
    if (m.op === 'callTool') result = await svc.callTool(m.name as any, m.args, m.opts);
    else if (m.op === 'status') result = await svc.status(m.cwd, m.nocache ? { nocache: true } : undefined);
    else if (m.op === 'brief') result = await svc.brief(m.cwd, m.agent as any);
    else if (m.op === 'fuzzy') result = require('./fuzzy').fuzzyForPrompt(m.prompt, m.root, m.generation);
    else if (m.op === 'bugLocalize') result = require('./bug-localize').localizeBug(m.prompt, m.root, m.generation);
    else throw new Error(`unknown op ${(m as any).op}`);
    port.postMessage({ id: m.id, ok: true, result });
  } catch (e: any) {
    const err = e instanceof GraphToolError
      ? { message: e.message, code: e.code, data: e.data ?? null, graphToolError: true }
      : { message: String(e?.message ?? e), code: 'error', data: null, graphToolError: false };
    port.postMessage({ id: m.id, ok: false, error: err });
    // A damaged store poisons this thread's koragraph connection for good (opened once, at module load); once the
    // store is moved aside and rebuilt, only a fresh thread sees the new file. Exit; offload.ts starts a new one.
    if (isStoreCorruptError(e)) setTimeout(() => process.exit(1), 50);
  }
});
port.postMessage({ ready: true });
