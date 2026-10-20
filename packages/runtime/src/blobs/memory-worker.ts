// The memory store, in a worker thread (docs/bots/ARCH.md section 4): recall, ingest, embeddings and the nightly tidy
// run here, so none of it can stall the daemon's event loop (CLAUDE.md: stalls of 2-9 s drop the UI websocket).
// Protocol (structured-clone messages):
//   main -> worker  { id, method, args }            call a MemoryStore method          -> { id, ok, result | error }
//   worker -> main  { xid, req }                    the extractor model call           <- { xid, ok, text | error }
//   main -> worker  { cancelTidy: true }            abort the running tidy
// The worker owns the only SQLite handle on memory.db. It imports nothing from the daemon.
import { parentPort, workerData } from 'node:worker_threads';
import { openMemory, createHashEmbedder, CoreTooLargeError, type MemoryStore } from '../memory';

type Pending = { resolve(t: string): void; reject(e: Error): void };

/** Methods the host may call (everything on MemoryStore except close, which is the worker's own lifecycle). */
export const MEMORY_METHODS = [
  'recall', 'getCore', 'setCore', 'getTeamCore', 'setTeamCore', 'ingestTurn', 'undo', 'approvePending', 'rejectPending',
  'listPending', 'listReceipts', 'listFacts', 'searchFacts', 'getFact', 'addFact', 'remember', 'editFact', 'forgetFact', 'forgetWithReceipt', 'markImportant',
  'pendingQuestions', 'resolveQuestion', 'summarizeThread', 'searchEpisodes', 'tidy', 'needsTidy', 'stats', 'forgetBlob',
] as const;

function main(): void {
  if (!parentPort) return;
  const port = parentPort;
  const pending = new Map<number, Pending>();
  let xseq = 0;
  let tidyAbort: AbortController | null = null;

  const extractor = (req: { system: string; prompt: string; maxTokens: number }): Promise<string> =>
    new Promise((resolve, reject) => {
      const xid = ++xseq;
      pending.set(xid, { resolve, reject });
      port.postMessage({ xid, req });
    });

  const mem: MemoryStore = openMemory({ dbPath: String((workerData as { dbPath: string }).dbPath), extractTimeoutMs: Number((workerData as { extractTimeoutMs?: number }).extractTimeoutMs) || undefined, extractor, embedder: createHashEmbedder() });
  const allowed = new Set<string>(MEMORY_METHODS);

  port.on('message', async (m: any) => {
    if (m?.cancelTidy) { tidyAbort?.abort(); return; }
    if (m?.xid != null) {
      const p = pending.get(m.xid); if (!p) return;
      pending.delete(m.xid);
      if (m.ok) p.resolve(String(m.text ?? '')); else p.reject(new Error(String(m.error ?? 'extractor failed')));
      return;
    }
    if (m?.close) { try { mem.close(); } catch { /* closed */ } port.postMessage({ closed: true }); return; }
    const { id, method, args } = m as { id: number; method: string; args: unknown[] };
    try {
      if (!allowed.has(method)) throw new Error(`unknown memory method ${method}`);
      let a = args ?? [];
      if (method === 'tidy') { tidyAbort = new AbortController(); a = [{ ...((a[0] as object) ?? {}), signal: tidyAbort.signal }]; }
      const result = await (mem as any)[method](...a);
      port.postMessage({ id, ok: true, result: result === undefined ? null : result });
    } catch (e: any) {
      port.postMessage({ id, ok: false, error: String(e?.message ?? e), name: e instanceof CoreTooLargeError ? 'CoreTooLargeError' : undefined });
    } finally {
      if (method === 'tidy') tidyAbort = null;
    }
  });
  port.postMessage({ ready: true });
}

main();
