// Test helper (not shipped logic): an in-memory OutsideHost + a clock, so outside access is tested without the daemon.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from './audit';
import { OutsideService } from './service';
import { RateLimiter } from './ratelimit';
import { TokenStore } from './tokens';
import type { OutsideBlob, OutsideHost, OutsideModelChoice, OutsideRow, OutsideThreadHead, SendRefusal, SendResult } from './types';

export function fakeClock(start = 1_800_000_000_000) {
  const c = { t: start, onSleep: null as null | (() => void), now: () => c.t, sleep: async (ms: number) => { c.t += ms; const h = c.onSleep; c.onSleep = null; h?.(); }, advance: (ms: number) => { c.t += ms; } };
  return c;
}

export function fakeHost(opts: { groups?: boolean } = {}) {
  const blobs: OutsideBlob[] = [
    { id: 'blob_kora', name: 'Kora', title: 'Chief', role: 'chief', status: 'idle', engine: { instanceId: 'claude', model: 'claude-sonnet-5-5' } },
    { id: 'blob_popo', name: 'Popo', title: 'Researcher', role: 'member', status: 'working', engine: { instanceId: 'claude', model: 'claude-haiku-5' } },
  ];
  const threads = new Map<string, OutsideThreadHead>();
  const rows = new Map<string, OutsideRow[]>();
  const sent: Array<{ blobId?: string; threadId?: string; text: string; via: { client: string; tokenId: string } }> = [];
  const interrupted: string[] = [];
  const models: Record<string, OutsideModelChoice[]> = {
    blob_popo: [{ instanceId: 'claude', model: 'claude-haiku-5', label: 'Haiku 5' }, { instanceId: 'claude', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }],
    blob_kora: [{ instanceId: 'claude', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }],
  };
  const groupSent: string[] = [];
  let n = 0; let refuse: SendRefusal['refused'] | null = null;
  const host: OutsideHost & { groups?: any } = {
    chiefId: () => 'blob_kora',
    listBlobs: () => blobs,
    describeBlob: (id) => (blobs.some((b) => b.id === id) ? { summary: `${id} summary`, card: `${id} card`, skills: ['research', 'docx'], workspaceName: id } : null),
    listThreads: (id) => [...threads.values()].filter((t) => t.blobId === id),
    getThread: (id) => threads.get(id) ?? null,
    threadRows: (id) => rows.get(id) ?? [],
    search: (q, limit) => [...threads.values()].filter((t) => t.title.toLowerCase().includes(q.toLowerCase())).slice(0, limit).map((t) => ({ kind: 'thread' as const, id: t.id, blobId: t.blobId, title: t.title, snippet: `...${t.title}...` })),
    async sendMessage(i): Promise<SendResult | SendRefusal> {
      if (refuse) return { refused: refuse };
      sent.push(i);
      const blobId = i.blobId ?? threads.get(i.threadId!)!.blobId;
      const id = i.threadId ?? `th${++n}`;
      if (!threads.has(id)) { threads.set(id, { id, blobId, title: i.text.slice(0, 30), status: 'running', updatedAt: Date.now(), messageCount: 1 }); rows.set(id, []); }
      threads.get(id)!.status = 'running';
      rows.get(id)!.push({ role: 'user', text: i.text, at: Date.now(), via: i.via.client });
      return { threadId: id, blobId };
    },
    allowedModels: (id) => models[id] ?? [],
    async setModel(id, c) { const b = blobs.find((x) => x.id === id)!; b.engine = { instanceId: c.instanceId, model: c.model }; return true; },
    async interrupt(id) { interrupted.push(id); threads.get(id)!.status = 'settled'; return true; },
    listOutputs: (id, limit) => (id === 'blob_popo' ? [{ path: 'outputs/lisbon.md', name: 'lisbon.md', bytes: 1200, at: 1, threadId: 'th1' }].slice(0, limit) : []),
  };
  if (opts.groups) host.groups = { list: () => [{ id: 'grp1', name: 'Launch', members: ['blob_kora', 'blob_popo'] }], send: async (i: any) => { groupSent.push(i.text); return { ok: true }; } };
  return {
    host, blobs, threads, rows, sent, interrupted, groupSent,
    refuseNext: (r: SendRefusal['refused'] | null) => { refuse = r; },
    addThread(id: string, blobId: string, status: OutsideThreadHead['status'], r: OutsideRow[], updatedAt = 1) { threads.set(id, { id, blobId, title: `Thread ${id}`, status, updatedAt, messageCount: r.length }); rows.set(id, r); },
  };
}

export function fixture(opts: { groups?: boolean; limits?: ConstructorParameters<typeof RateLimiter>[0] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-'));
  const clock = fakeClock();
  const h = fakeHost(opts);
  const tokens = new TokenStore(dir, clock.now);
  const audit = new AuditLog(dir, clock.now);
  const svc = new OutsideService({ host: h.host, tokens, audit, limiter: new RateLimiter(opts.limits, clock.now), sleep: clock.sleep, now: clock.now });
  const made = tokens.create('Claude Desktop');
  if (!made.ok) throw new Error('fixture token');
  return { dir, clock, h, tokens, audit, svc, token: made.token, tokenId: made.record.id, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
