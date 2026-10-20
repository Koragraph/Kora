// The daemon-side handle on the memory store. Every call is a message to the memory worker (memory-worker.ts), so SQLite,
// embeddings and tidy never run on the event loop. `MemoryHost.inline(store)` wraps an in-thread store for tests.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { MemoryStore } from '../memory';
import { MEMORY_METHODS } from './memory-worker';
import { log } from '../server/log';
import { DEFAULT_CALL_TIMEOUT_MS, EXTRACT_CALL_TIMEOUT_MS, EXTRACT_DEADLINE_MS } from './extract-budget';

/** Async twin of MemoryStore (a worker call is always a Promise). */
export type MemoryFacade = { [K in keyof MemoryStore]: (...a: Parameters<MemoryStore[K]>) => Promise<Awaited<ReturnType<MemoryStore[K]>>> };
export type ExtractorFn = (req: { system: string; prompt: string; maxTokens: number }) => Promise<string>;

export interface MemoryHost extends MemoryFacade {
  /** Where the extractor model call is served from (set once the daemon's one-shot chain exists). */
  setExtractor(fn: ExtractorFn | null): void;
  cancelTidy(): void;
  close(): Promise<void>;
}

/** Methods that run the extractor chain: their host timeout is derived from the chain's own budget (always longer). */
const EXTRACTOR_METHODS = new Set(['ingestTurn', 'summarizeThread']);
export function callTimeoutMs(method: string): number {
  return EXTRACTOR_METHODS.has(method) ? EXTRACT_CALL_TIMEOUT_MS : DEFAULT_CALL_TIMEOUT_MS;
}

export class MemoryWorkerHost {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  private extractor: ExtractorFn | null = null;
  private closed = false;
  private restarts = 0;
  private ready: Promise<void> | null = null;

  constructor(private dbPath: string, private workerFile = path.join(__dirname, 'memory-worker.js'), private extractDeadlineMs = EXTRACT_DEADLINE_MS) {}

  setExtractor(fn: ExtractorFn | null): void { this.extractor = fn; }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const w = new Worker(this.workerFile, { workerData: { dbPath: this.dbPath, extractTimeoutMs: this.extractDeadlineMs } });
    this.worker = w;
    this.ready = new Promise<void>((resolve, reject) => {
      w.once('error', (e) => reject(e));
      w.on('message', (m: any) => {
        if (m?.ready) { resolve(); return; }
        if (m?.xid != null) { void this.serveExtract(w, m); return; }
        if (m?.id != null) {
          const p = this.pending.get(m.id); if (!p) return;
          this.pending.delete(m.id); clearTimeout(p.timer);
          if (m.ok) p.resolve(m.result); else { const e = new Error(m.error); if (m.name) e.name = m.name; p.reject(e); }
        }
      });
    });
    const fail = (e: Error) => {
      if (this.worker !== w) return;
      this.worker = null; this.ready = null;
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(e); this.pending.delete(id); }
    };
    w.on('error', (e) => { log('blobs: memory worker error', e); fail(e instanceof Error ? e : new Error(String(e))); });
    w.on('exit', (code) => { if (!this.closed) log(`blobs: memory worker exited (${code})`); fail(new Error(`memory worker exited (${code})`)); });
    w.unref(); // never keeps the daemon alive by itself
    return this.ready;
  }

  private async serveExtract(w: Worker, m: { xid: number; req: { system: string; prompt: string; maxTokens: number } }): Promise<void> {
    try {
      if (!this.extractor) throw new Error('no extractor available');
      w.postMessage({ xid: m.xid, ok: true, text: await this.extractor(m.req) });
    } catch (e: any) {
      w.postMessage({ xid: m.xid, ok: false, error: String(e?.message ?? e) });
    }
  }

  async call(method: string, args: unknown[]): Promise<any> {
    if (this.closed) throw new Error('memory is closed');
    try { await this.start(); }
    catch (e) {
      // one automatic restart per call chain; a worker that cannot even start must not wedge every turn
      this.worker = null; this.ready = null;
      if (++this.restarts > 3) throw e;
      await this.start();
    }
    const w = this.worker!;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`memory.${method} timed out`)); }, callTimeoutMs(method));
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      w.postMessage({ id, method, args });
    });
  }

  cancelTidy(): void { this.worker?.postMessage({ cancelTidy: true }); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const w = this.worker; this.worker = null;
    if (!w) return;
    await new Promise<void>((res) => {
      const t = setTimeout(() => res(), 2000); t.unref();
      w.once('message', (m: any) => { if (m?.closed) { clearTimeout(t); res(); } });
      try { w.postMessage({ close: true }); } catch { res(); }
    });
    await w.terminate().catch(() => {});
  }
}

/** Build the facade: each MemoryStore method becomes a worker call. */
export function memoryHost(dbPath: string, workerFile?: string, o: { extractDeadlineMs?: number } = {}): MemoryHost {
  const h = new MemoryWorkerHost(dbPath, workerFile, o.extractDeadlineMs);
  const facade: any = {
    setExtractor: (fn: ExtractorFn | null) => h.setExtractor(fn),
    cancelTidy: () => h.cancelTidy(),
    close: () => h.close(),
  };
  for (const m of MEMORY_METHODS) facade[m] = (...a: unknown[]) => h.call(m, a.map((x) => (x && typeof x === 'object' && 'signal' in (x as object) ? { ...(x as object), signal: undefined } : x)));
  return facade as MemoryHost;
}

/** Wrap an in-thread store (unit tests, fakes): same facade, no worker. */
export function inlineMemoryHost(store: MemoryStore, setExtractor: (fn: ExtractorFn | null) => void = () => {}): MemoryHost {
  const facade: any = { setExtractor, cancelTidy: () => {}, close: async () => store.close() };
  for (const m of MEMORY_METHODS) facade[m] = async (...a: unknown[]) => (store as any)[m](...a);
  return facade as MemoryHost;
}
