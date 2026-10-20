// Pieces the ACP driver and the API driver share (Phase 7): the parked-approval gate, the posture -> decision rule, the
// path-confinement check and a tiny event-bus. Pure / dependency-light so both drivers and their tests use them as-is.
import fs from 'node:fs';
import path from 'node:path';
import type { ApprovalAnswer, ApprovalKind, ChatEvent, RequestId, RuntimeMode, ThreadId, UnsequencedChatEvent } from '../events';
import { OUTBOUND_BASH } from '../blob-policy';
import { killTreeWindows } from '../../util/win-exec';
import { patternKillReason, sensitiveOverride, sensitivePathReason, sensitiveShellPathReason, sensitiveShellReason } from '../sensitive-guard';

/**
 * SIGTERM `child`, then SIGKILL after `graceMs` if it has not exited. Tests exit state, never `child.killed`: Node sets
 * `killed` as soon as a signal is DELIVERED, so `if (!child.killed) kill('SIGKILL')` never escalated and a CLI that
 * ignored SIGTERM kept running after Stop (deep audit A3-2).
 * Windows: a signal ends only that one process, so a CLI behind `cmd.exe /c` (winCommand's batch-file path) outlived
 * Stop; the whole tree is ended instead (`taskkill /T /F`).
 */
export function terminateChild(child: { pid?: number; kill(sig?: NodeJS.Signals): boolean; exitCode: number | null; signalCode: NodeJS.Signals | null } | null | undefined, graceMs = 2000): void {
  if (!child) return;
  if (process.platform === 'win32' && child.pid) { if (child.exitCode == null && child.signalCode == null) killTreeWindows(child.pid); return; }
  try { child.kill('SIGTERM'); } catch { /* gone */ }
  const t = setTimeout(() => { try { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); } catch { /* gone */ } }, graceMs);
  t.unref?.();
}

/** A tiny listener set with the `seq: 0` envelope every driver stamps (the manager assigns the real seq). */
export class EventBus {
  private listeners = new Set<(e: ChatEvent) => void>();
  subscribe(fn: (e: ChatEvent) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(threadId: ThreadId, ev: UnsequencedChatEvent): void {
    const full = { seq: 0, at: Date.now(), ...ev, threadId } as ChatEvent;
    for (const l of this.listeners) { try { l(full); } catch { /* isolate a bad listener */ } }
  }
}

export interface AskInput { title: string; detail?: string; kind: ApprovalKind; args?: unknown; turnId?: string | null; options?: { decision: ApprovalAnswer; label: string }[]; alwaysLabel?: string; /** Aborts when the question was answered elsewhere (the browser panel's bar): the card retires as cancelled. */ signal?: AbortSignal }

/** Parked approvals: `ask` emits approval.opened and resolves when the UI answers (respondToApproval) or the turn is cancelled. */
export class ApprovalGate {
  private pending = new Map<RequestId, { resolve: (d: ApprovalAnswer) => void; threadId: ThreadId }>();
  private seq = 0;
  private tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  constructor(private bus: EventBus) {}

  ask(threadId: ThreadId, a: AskInput): Promise<ApprovalAnswer> {
    // Unique for the thread's whole life (see claude-driver: reused ids after a restart hid prompts and hung turns).
    const requestId: RequestId = `appr_${threadId}_${this.tag}_${++this.seq}`;
    // Register before emitting: a listener may answer synchronously.
    const p = new Promise<ApprovalAnswer>((resolve) => { this.pending.set(requestId, { resolve, threadId }); });
    this.bus.emit(threadId, {
      type: 'approval.opened', requestId, requestKind: a.kind, title: a.title, ...(a.detail ? { detail: a.detail } : {}), ...(a.args !== undefined ? { args: a.args } : {}),
      options: a.options ?? [{ decision: 'accept', label: 'Allow' }, { decision: 'acceptForSession', label: 'Allow for session' }, { decision: 'decline', label: 'Deny' }],
      ...(a.turnId ? { turnId: a.turnId } : {}), ...(a.alwaysLabel ? { alwaysLabel: a.alwaysLabel } : {}),
    });
    if (a.signal) { if (a.signal.aborted) this.cancelOne(requestId); else a.signal.addEventListener('abort', () => this.cancelOne(requestId), { once: true }); }
    return p;
  }
  private cancelOne(requestId: RequestId): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    this.bus.emit(p.threadId, { type: 'approval.resolved', requestId, decision: 'cancel' });
    p.resolve('cancel');
  }
  /** Returns false when the id is unknown (already answered). */
  respond(threadId: ThreadId, requestId: RequestId, decision: ApprovalAnswer): boolean {
    const p = this.pending.get(requestId);
    if (!p || p.threadId !== threadId) return false;
    this.pending.delete(requestId);
    this.bus.emit(threadId, { type: 'approval.resolved', requestId, decision });
    p.resolve(decision);
    return true;
  }
  /** Settle every open approval of a thread as `cancel` (turn interrupted, session stopped). */
  cancelAll(threadId: ThreadId): void {
    for (const [id, p] of [...this.pending]) if (p.threadId === threadId) { this.pending.delete(id); this.bus.emit(threadId, { type: 'approval.resolved', requestId: id, decision: 'cancel' }); p.resolve('cancel'); }
  }
  count(threadId: ThreadId): number { let n = 0; for (const p of this.pending.values()) if (p.threadId === threadId) n++; return n; }
}

/**
 * The `askApproval` a blob's tools get on an ACP / API engine: the same inline approval card as every other engine
 * (Allow once / Always for this blob / Deny), parked on this driver's gate. Fails closed: only an explicit allow is true.
 */
export function blobAskVia(gate: ApprovalGate, threadId: ThreadId, turnOf: () => string | null | undefined) {
  return async (p: { title: string; detail: string; args: unknown; always?: { label: string; remember(): void }; signal?: AbortSignal }): Promise<boolean> => {
    const d = await gate.ask(threadId, {
      title: p.title, detail: p.detail, kind: 'mcp_elicitation_approval', args: p.args, turnId: turnOf() ?? null,
      options: [{ decision: 'accept', label: 'Allow once' }, ...(p.always ? [{ decision: 'acceptAlways' as const, label: 'Always for this blob' }] : []), { decision: 'decline', label: 'Deny' }],
      ...(p.always ? { alwaysLabel: p.always.label } : {}), ...(p.signal ? { signal: p.signal } : {}),
    });
    if (d === 'acceptAlways') { try { p.always?.remember(); } catch { /* the yes still stands for this call */ } }
    return d === 'accept' || d === 'acceptForSession' || d === 'acceptAlways';
  };
}

// ── posture ──────────────────────────────────────────────────────────────────────────────────────────────────────
export type ActionClass = 'read' | 'edit' | 'execute' | 'fetch' | 'other';
export interface PostureInput { mode: RuntimeMode | undefined; action: ActionClass; /** the shell line, for `execute` */ command?: string; /** the working folder: lets the shell check follow a symlink in the repo to a credential (`cat link.txt`) */ cwd?: string; /** every path the action touches (absolute) */ paths?: string[]; inBounds: (abs: string) => boolean }
export interface PostureVerdict { decision: 'allow' | 'ask' | 'deny'; reason: string }

export function isOutbound(command: string | undefined): boolean { return !!command && OUTBOUND_BASH.test(command); }

/**
 * The blob posture, same meaning as Claude's (blob-policy.ts):
 *   full-access          -> everything allowed
 *   approval-required    -> reads and research free; edits and commands ask
 *   auto / auto-accept   -> free inside the folders; outside them, and any outbound shell, asks
 * "Outbound always asks" holds on every posture except Full access (which the user chose explicitly).
 */
export function postureVerdict(i: PostureInput): PostureVerdict {
  // A pattern kill is denied on every posture (it stops other agents' processes); nothing asks, nothing overrides it.
  if (i.action === 'execute' && i.command) { const kill = patternKillReason(i.command); if (kill) return { decision: 'deny', reason: kill }; }
  // Keys and credentials ask on every posture, Full access included (session/sensitive-guard.ts, one matcher for all lanes).
  if (!sensitiveOverride()) {
    const why = (i.action === 'execute' && i.command ? sensitiveShellReason(i.command) ?? (i.cwd ? sensitiveShellPathReason(i.command, i.cwd) : null) : null) ?? (i.paths ?? []).map((p) => sensitivePathReason(p)).find(Boolean);
    if (why) return { decision: 'ask', reason: `${why}: keys and credentials always ask` };
  }
  if (i.mode === 'full-access') return { decision: 'allow', reason: 'full access' };
  if (i.action === 'execute' && isOutbound(i.command)) return { decision: 'ask', reason: 'this command can send data out or act outside the workspace' };
  const outside = (i.paths ?? []).find((p) => !i.inBounds(p));
  if (outside) return { decision: 'ask', reason: `outside the workspace: ${outside}` };
  if (i.action === 'read' || i.action === 'fetch') return { decision: 'allow', reason: 'read-only' };
  if (i.mode === 'auto' || i.mode === 'auto-accept-edits') return { decision: 'allow', reason: 'inside the workspace' };
  return { decision: 'ask', reason: 'Supervised mode asks before editing or running commands' };
}

// ── confinement ──────────────────────────────────────────────────────────────────────────────────────────────────
function real(p: string): string { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
/** realpath of the nearest existing ancestor + the not-yet-existing tail, so a new file in a symlinked folder still resolves. */
export function resolveLoose(p: string): string {
  let cur = path.resolve(p); const tail: string[] = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { tail.unshift(path.basename(cur)); cur = path.dirname(cur); }
  return path.join(real(cur), ...tail);
}
export function within(target: string, roots: string[]): boolean {
  const t = resolveLoose(target);
  return roots.map(real).some((r) => t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}
/** An absolute path inside `roots` (symlinks resolved), or throws a readable error. Relative paths are refused (ACP requires absolute). */
export function confine(p: unknown, roots: string[], base?: string): string {
  if (typeof p !== 'string' || !p) throw new Error('path is required');
  const abs = path.isAbsolute(p) ? p : base ? path.join(base, p) : '';
  if (!abs) throw new Error('path must be absolute');
  if (!within(abs, roots)) throw new Error(`path is outside the workspace: ${p}`);
  return resolveLoose(abs);
}

export function truncate(s: string, max: number): string { return s.length > max ? s.slice(0, max) + `\n[truncated ${s.length - max} chars]` : s; }
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A calm sentence for a rate-limit / quota message, used by both drivers to decide whether to show the card. */
export const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests|quota|resource.?exhausted|overloaded|usage limit/i;
