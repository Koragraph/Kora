// Test helpers for the Phase 2 team code (not shipped logic): a temp home, a store with a few blobs, a fake engine bridge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BlobEngineBridge } from './jobs';
import type { BlobEngine } from './types';

export const ENGINE: BlobEngine = { instanceId: 'claude', model: 'claude-sonnet-5-5', effort: null };

export function tempHome(prefix = 'team-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.KORA_BLOBS_ROOT = path.join(root, 'Blobs');
  process.env.KORA_HOME = path.join(root, 'kora-home');
  return root;
}

/** Wipe blobs + workspaces so each test starts from an empty team (the home is per test file). */
export function resetHome(): void {
  fs.rmSync(path.join(process.env.KORA_HOME!, 'blobs'), { recursive: true, force: true });
  fs.rmSync(process.env.KORA_BLOBS_ROOT!, { recursive: true, force: true });
}

export interface FakeThread { threadId: string; blobId: string; title: string; prompt: string; origin: any; koraThreadId: string | null }

/** A scriptable BlobEngineBridge: tests set `running`, push `snapshots`, and call `settle`. */
export function fakeBridge() {
  const threads: FakeThread[] = [];
  const running = new Map<string, number>();
  const snapshots = new Map<string, ReturnType<BlobEngineBridge['snapshot']>>();
  const cards: Array<{ koraThreadId: string; card: any }> = [];
  const notes: Array<{ koraThreadId: string; text: string }> = [];
  const sent: Array<{ threadId: string; text: string }> = [];
  const interrupted: string[] = [];
  let settledCb: ((e: { threadId: string; koraThreadId: string; blobId: string; ok: boolean }) => void) | null = null;
  let refuse: 'busy' | 'archived' | 'unknown' | null = null;
  let n = 0;
  const bridge: BlobEngineBridge = {
    async startThread(p) {
      if (refuse) return { refused: refuse };
      const threadId = `th${++n}`;
      threads.push({ threadId, blobId: p.blobId, title: p.title, prompt: p.prompt, origin: p.origin, koraThreadId: p.fromKoraThreadId });
      running.set(p.blobId, (running.get(p.blobId) ?? 0) + 1);
      snapshots.set(threadId, { state: 'running', finalText: null, outputs: [], tokens: { input: 0, cached: 0, output: 0, turns: 0 } });
      return { threadId, koraThreadId: p.fromKoraThreadId ?? 'kt' };
    },
    async sendToThread(threadId, text) { sent.push({ threadId, text }); },
    snapshot: (id) => snapshots.get(id) ?? null,
    runningCount: (id) => running.get(id) ?? 0,
    appendCard: (koraThreadId, card) => { cards.push({ koraThreadId, card }); },
    queueNote: (koraThreadId, text) => { notes.push({ koraThreadId, text }); },
    onSettled: (cb) => { settledCb = cb; return () => { settledCb = null; }; },
    interrupt: (id) => { interrupted.push(id); },
  };
  return {
    bridge, threads, running, snapshots, cards, notes, sent, interrupted,
    setRefuse(r: 'busy' | 'archived' | 'unknown' | null) { refuse = r; },
    /** The thread finishes: snapshot becomes `state`, the running count drops, onSettled fires. */
    finish(threadId: string, o: { state?: 'idle' | 'needs-you' | 'error'; finalText?: string; outputs?: string[]; ok?: boolean; tokens?: number } = {}) {
      const t = threads.find((x) => x.threadId === threadId)!;
      snapshots.set(threadId, { state: o.state ?? 'idle', finalText: o.finalText ?? 'Done. Here is the result.', outputs: o.outputs ?? [], tokens: { input: o.tokens ?? 100, cached: 0, output: 50, turns: 1 } });
      running.set(t.blobId, Math.max(0, (running.get(t.blobId) ?? 1) - 1));
      return settledCb?.({ threadId, koraThreadId: t.koraThreadId ?? 'kt', blobId: t.blobId, ok: o.ok ?? true });
    },
    /** The engine saw something that is not a settled turn (an approval answered): watchers re-read the snapshot. */
    poke(threadId: string) {
      const t = threads.find((x) => x.threadId === threadId)!;
      return settledCb?.({ threadId, koraThreadId: t.koraThreadId ?? 'kt', blobId: t.blobId, ok: true });
    },
    lastCard(cardId: string) { return [...cards].reverse().find((c) => c.card.cardId === cardId)?.card; },
  };
}
