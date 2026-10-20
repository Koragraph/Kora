// Test helpers for routines (not shipped logic): a temp home with a few blobs, a fake clock and a scriptable bridge.
import { ENGINE, resetHome, tempHome } from '../testkit-team';
import { BlobStore } from '../store';
import { CHIEF_SOUL } from '../chief';
import { hireTemplate } from '../templates';
import type { RoutineBridge, HiddenThreadOrigin } from './engine';
import { RoutineService } from './service';
import type { RoutineReportCard } from './types';

export { tempHome };

export interface Harness {
  store: BlobStore;
  svc: RoutineService;
  bridge: ReturnType<typeof fakeRoutineBridge>;
  clock: { t: number };
  kora: { id: string; name: string };
  popo: { id: string; name: string };
  junip: { id: string; name: string };
  tibbo: { id: string; name: string };
  notes: Array<{ blobId: string; kind: string; title: string }>;
}

export function fakeRoutineBridge() {
  const threads: Array<{ threadId: string; blobId: string; title: string; prompt: string; origin: HiddenThreadOrigin }> = [];
  const snaps = new Map<string, { state: 'running' | 'idle' | 'needs-you' | 'error'; finalText: string | null; outputs: string[] }>();
  const reports: Array<{ resultsThreadId: string; card: RoutineReportCard }> = [];
  const interrupted: string[] = [];
  const created: Array<{ blobId: string; title: string; threadId: string }> = [];
  const gone = new Set<string>();
  const deleted: string[] = [];
  let refuseDelete = new Set<string>();
  let settled: ((e: { threadId: string; blobId: string; ok: boolean }) => void) | null = null;
  let busy = false; let n = 0;
  const bridge: RoutineBridge = {
    async startHiddenThread(p) {
      if (busy) return { refused: 'busy' };
      const threadId = `hid${++n}`;
      threads.push({ threadId, blobId: p.blobId, title: p.title, prompt: p.prompt, origin: p.origin });
      snaps.set(threadId, { state: 'running', finalText: null, outputs: [] });
      return { threadId };
    },
    snapshot: (id) => snaps.get(id) ?? null,
    interrupt: (id) => { interrupted.push(id); },
    async createResultsThread(p) { const threadId = `res${created.length + 1}`; created.push({ ...p, threadId }); return { threadId }; },
    threadExists: (id) => !gone.has(id),
    async deleteHiddenThread(id) { if (refuseDelete.has(id)) return false; deleted.push(id); gone.add(id); snaps.delete(id); return true; },
    async postReport(resultsThreadId, card) { reports.push({ resultsThreadId, card }); return true; },
    onSettled: (cb) => { settled = cb; return () => { settled = null; }; },
  };
  return {
    bridge, threads, snaps, reports, interrupted, created, gone, deleted,
    refuseDelete(...ids: string[]) { refuseDelete = new Set(ids); },
    setBusy(v: boolean) { busy = v; },
    /** The model finished (or needs you / failed). Resolves once the engine has handled the event. */
    async finish(threadId: string, o: { state?: 'idle' | 'needs-you' | 'error' | 'running'; finalText?: string; ok?: boolean } = {}) {
      const t = threads.find((x) => x.threadId === threadId)!;
      snaps.set(threadId, { state: o.state ?? 'idle', finalText: o.finalText ?? 'All done.', outputs: [] });
      settled?.({ threadId, blobId: t.blobId, ok: o.ok ?? true });
      await new Promise((r) => setTimeout(r, 15));
    },
  };
}

export function harness(start = Date.UTC(2026, 9, 5, 0, 0, 0), over: { webhookPort?: number; receiver?: { rateLimit?: number; maxBodyBytes?: number } } = {}): Harness {
  resetHome();
  const store = new BlobStore();
  const kora = store.ensureKora(ENGINE, CHIEF_SOUL);
  const popo = (hireTemplate(store, 'popo', { defaultEngine: ENGINE }) as any).profile;
  const junip = (hireTemplate(store, 'junip', { defaultEngine: ENGINE }) as any).profile;
  const tibbo = (hireTemplate(store, 'tibbo', { defaultEngine: ENGINE }) as any).profile;
  const bridge = fakeRoutineBridge();
  const clock = { t: start };
  const notes: Harness['notes'] = [];
  const svc = new RoutineService({
    blobs: store as never, bridge: () => bridge.bridge, now: () => clock.t, webhookPort: over.webhookPort ?? 0,
    ...(over.receiver ? { receiver: over.receiver } : {}),
    notify: (blobId, kind, title) => { notes.push({ blobId, kind, title }); },
  });
  return { store, svc, bridge, clock, kora, popo, junip, tibbo, notes };
}
