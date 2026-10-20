// makeOutsideHost: the `OutsideHost` (outside/types.ts) over the real stores and the chat engine. This is the ONLY object the
// outside-access tools can reach: nothing here answers an approval, deletes, edits settings, memory, grants, secrets or
// routines. Anything not listed in OutsideHost is not reachable from an outside client.
import fs from 'node:fs';
import path from 'node:path';
import { renderCard, type CapabilityCard } from '../cards';
import { CHIEF_BLOB_ID, type BlobEngine, type BlobProfile } from '../types';
import type { GroupStore } from '../groups/store';
import type {
  OutsideBlob, OutsideGroup, OutsideHost, OutsideModelChoice, OutsideOutput, OutsideRow, OutsideSearchHit, OutsideThreadHead, SendRefusal, SendResult,
} from './types';

/** What the ui-server's chat engine offers the outside host (BlobEngineBridge.outside, host.ts). All read the engine's own read model. */
export interface OutsideEngine {
  /** Visible threads of a blob (not archived, never a routine run or a group member session), newest first. */
  threads(blobId: string): OutsideThreadHead[];
  thread(threadId: string): OutsideThreadHead | null;
  /** Normalised rows (tool calls as one summary line, output cards as names). */
  rows(threadId: string): OutsideRow[];
  /** Does the blob have a thread waiting on the user / a turn running? */
  blobState(blobId: string): 'idle' | 'working' | 'needs-you' | 'error';
  search(query: string, blobIds: readonly string[], limit: number): OutsideSearchHit[];
  /** Models the app's picker offers for an engine instance. */
  models(instanceId: string): Array<{ model: string; label: string }>;
  /** New thread (blobId) or a follow-up (threadId); marks the user message `via`. Returns once the turn is registered running. */
  send(i: { blobId?: string; threadId?: string; text: string; via: { client: string; tokenId: string } }): Promise<SendResult | SendRefusal>;
  interrupt(threadId: string): Promise<boolean>;
  /** Group posting (feature-detected). */
  groupSend?(i: { groupId: string; text: string; via: { client: string; tokenId: string } }): Promise<{ ok: boolean; message?: string }>;
}

export interface OutsideHostDeps {
  store: {
    list(o?: { includeArchived?: boolean }): BlobProfile[];
    get(id: string): BlobProfile | null;
    update(id: string, patch: { engine: BlobEngine }): BlobProfile;
  };
  /** Capability cards (TeamCards.cards()); Kora has none and is described from her profile. */
  cardOf(blobId: string): CapabilityCard | null;
  skillNames(blobId: string): string[];
  engine: OutsideEngine;
  groups?: Pick<GroupStore, 'list'>;
  koraReady(): boolean;
}

const OUTPUT_SCAN_LIMIT = 400;

function modelLabel(engine: BlobEngine): string { return `${engine.instanceId} ${engine.model}`; }

export function makeOutsideHost(d: OutsideHostDeps): OutsideHost {
  const active = (b: BlobProfile | null): b is BlobProfile => !!b && b.archivedAt == null;
  const outsideBlob = (b: BlobProfile): OutsideBlob => ({
    id: b.id, name: b.name, title: b.title, role: b.role, status: d.engine.blobState(b.id), engine: { instanceId: b.engine.instanceId, model: b.engine.model },
  });

  const host: OutsideHost = {
    chiefId: () => (d.koraReady() ? CHIEF_BLOB_ID : null),
    listBlobs: () => d.store.list().filter(active).map(outsideBlob),

    describeBlob(blobId) {
      const b = d.store.get(blobId);
      if (!active(b)) return null;
      const card = d.cardOf(blobId);
      return {
        summary: `${b.name}, ${b.title || 'blob'}. Runs on ${modelLabel(b.engine)}; permission ${b.permission === 'ask' ? 'Ask' : b.permission === 'auto' ? 'Auto' : 'Full'}.`,
        card: card ? renderCard(card) : null,
        skills: d.skillNames(blobId).slice(0, 40),
        workspaceName: path.basename(b.workspace),
      };
    },

    listThreads: (blobId) => (active(d.store.get(blobId)) ? d.engine.threads(blobId) : []),
    getThread(threadId) {
      const t = d.engine.thread(threadId);
      return t && active(d.store.get(t.blobId)) ? t : null;
    },
    threadRows(threadId) {
      const t = d.engine.thread(threadId);
      return t && active(d.store.get(t.blobId)) ? d.engine.rows(threadId) : [];
    },

    search(query, limit) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const blobs = d.store.list().filter(active);
      const hits: OutsideSearchHit[] = [];
      for (const b of blobs) {
        if (b.name.toLowerCase().includes(q) || b.title.toLowerCase().includes(q)) hits.push({ kind: 'blob', id: b.id, blobId: b.id, title: b.name, snippet: b.title });
      }
      hits.push(...d.engine.search(q, blobs.map((b) => b.id), limit));
      for (const b of blobs) {
        for (const o of listFiles(path.join(b.workspace, 'outputs'), 200)) {
          if (o.name.toLowerCase().includes(q)) hits.push({ kind: 'output', id: o.path, blobId: b.id, title: o.name, snippet: `${b.name}: ${o.path}` });
        }
      }
      return hits.slice(0, limit);
    },

    sendMessage: async (i) => {
      if (i.blobId && !active(d.store.get(i.blobId))) return { refused: 'archived' };
      return d.engine.send(i);
    },

    allowedModels(blobId): OutsideModelChoice[] {
      const b = d.store.get(blobId);
      if (!active(b)) return [];
      return d.engine.models(b.engine.instanceId).map((m) => ({ instanceId: b.engine.instanceId, model: m.model, label: m.label }));
    },
    async setModel(blobId, choice) {
      const b = d.store.get(blobId);
      if (!active(b)) return false;
      if (!d.engine.models(choice.instanceId).some((m) => m.model === choice.model)) return false;
      d.store.update(blobId, { engine: { ...b.engine, instanceId: choice.instanceId, model: choice.model } });
      return true;
    },
    interrupt: (threadId) => d.engine.interrupt(threadId),

    listOutputs(blobId, limit) {
      const b = d.store.get(blobId);
      if (!active(b)) return [];
      return listFiles(path.join(b.workspace, 'outputs'), limit);
    },
  };

  // feature-detected per call: the group tools exist only while a group does
  if (d.groups) {
    const groups = d.groups;
    Object.defineProperty(host, 'groups', {
      enumerable: true,
      get: (): OutsideHost['groups'] => {
        if (!d.engine.groupSend || groups.list().length === 0) return undefined;
        const send = d.engine.groupSend.bind(d.engine);
        return { list: (): OutsideGroup[] => groups.list().map((g) => ({ id: g.id, name: g.name, members: [...g.memberIds] })), send };
      },
    });
  }
  return host;
}

/** Files under `dir` (recursive, files only), newest first, paths relative to the blob workspace's parent folder name `outputs/…`. */
export function listFiles(dir: string, limit: number): OutsideOutput[] {
  const out: OutsideOutput[] = [];
  const root = path.dirname(dir);
  const walk = (d: string, depth: number) => {
    if (out.length >= OUTPUT_SCAN_LIMIT || depth > 4) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(full);
        out.push({ path: path.relative(root, full), name: e.name, bytes: st.size, at: st.mtimeMs, threadId: null });
      } catch { /* vanished */ }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, Math.max(0, limit));
}
