// The outbound-approval plumbing for connected app actions (docs/bots/APPS.md "Outbound").
//
//   argsSummary      the few arguments a person actually decides on ("to: sam@acme.com · subject: Invoice"), never the whole JSON
//   approvalCopy     title / detail / args of the approval card for one request
//   ParkedApprovals  a yes/no the tool handler awaits: opens an `approval.opened` on the thread, resolves when the UI answers
//                    (`respondToApproval`), the turn is cancelled, or the timeout passes. Fails closed: only an explicit Allow is true.
//
// Every engine uses the same helper (Claude's in-process tools, and Codex / OpenCode through the `kora_blobs` MCP bridge, whose
// handler runs in the daemon), so "Auto never auto-approves an outbound action" holds the same way everywhere.
import type { ApprovalRequest } from './service';

/** Under Codex's 600 s MCP tool timeout, so a forgotten card ends as "denied", not as a dead tool call. */
export const APPROVAL_TIMEOUT_MS = 9 * 60_000;

/** Argument names worth showing first, in this order (a recipient before a body). */
const KEY_ORDER = ['to', 'recipient', 'recipients', 'recipient_email', 'cc', 'bcc', 'subject', 'channel', 'channel_id', 'channel_name', 'user', 'title', 'summary', 'name', 'repo', 'repository', 'owner', 'issue_number', 'pull_number', 'start_time', 'start', 'end_time', 'end', 'date', 'attendees', 'amount', 'currency', 'text', 'message', 'body', 'content', 'description'];
const BODYISH = new Set(['text', 'message', 'body', 'content', 'description']);

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

function short(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return clip(v.replace(/\s+/g, ' ').trim(), 90);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return clip(v.map((x) => short(x)).filter(Boolean).join(', '), 90);
  try { return clip(JSON.stringify(v), 90); } catch { return ''; }
}

/** Up to `max` "key: value" lines for the card; empty values and noise are dropped. */
export function argsSummary(args: Record<string, unknown> | undefined, max = 4): string {
  const a = args && typeof args === 'object' ? args : {};
  const keys = Object.keys(a);
  const ranked = [...keys.filter((k) => KEY_ORDER.includes(k)).sort((x, y) => KEY_ORDER.indexOf(x) - KEY_ORDER.indexOf(y)), ...keys.filter((k) => !KEY_ORDER.includes(k))];
  const lines: string[] = [];
  for (const k of ranked) {
    const v = short(a[k]);
    if (!v) continue;
    lines.push(`${k.replace(/_/g, ' ')}: ${BODYISH.has(k) ? `"${v}"` : v}`);
    if (lines.length >= max) break;
  }
  const more = keys.filter((k) => short(a[k])).length - lines.length;
  return lines.join('\n') + (more > 0 ? `\n+ ${more} more` : '');
}

const TOOLKIT_NAMES: Record<string, string> = { gmail: 'Gmail', googlecalendar: 'Google Calendar', googledrive: 'Google Drive', googlesheets: 'Google Sheets', googledocs: 'Google Docs', slack: 'Slack', github: 'GitHub', notion: 'Notion', linear: 'Linear', outlook: 'Outlook', discord: 'Discord', jira: 'Jira', hubspot: 'HubSpot' };
export function toolkitLabel(toolkit: string): string { return TOOLKIT_NAMES[toolkit.toLowerCase()] ?? toolkit.charAt(0).toUpperCase() + toolkit.slice(1); }

/** What the approval card says. `args.kind === 'app-action'` is how the transcript recognises it. */
export function approvalCopy(req: ApprovalRequest, args: Record<string, unknown>, blobName: string): { title: string; detail: string; args: Record<string, unknown> } {
  const summary = argsSummary(args);
  return {
    title: `${blobName} wants to: ${req.summary}`,
    detail: [req.summary, summary].filter(Boolean).join('\n'),
    args: { kind: 'app-action', toolkit: req.toolkit, appName: toolkitLabel(req.toolkit), tool: req.tool, account: req.account?.alias ?? req.account?.id ?? null, reason: req.reason, summary },
  };
}

type Decision = 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel';
const isAllow = (d: string) => d === 'accept' || d === 'acceptForSession' || d === 'acceptAlways';

export interface ParkedEmit {
  opened(requestId: string): void;
  resolved(requestId: string, decision: Decision): void;
  /** "Always for this blob" was the answer: persist the standing rule (runs before the tool is told yes). */
  always?(): void;
}

/** One per driver. `ask` parks; `respond` (from the driver's `respondToApproval`) answers. */
export class ParkedApprovals {
  private pending = new Map<string, { threadId: string; settle: (d: Decision) => void }>();
  private seq = 0;
  private tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

  /** The request id this class would hand out next is unique for the thread's whole life (a reused id hides prompts, see claude-driver). */
  ask(threadId: string, emit: ParkedEmit, timeoutMs = APPROVAL_TIMEOUT_MS, signal?: AbortSignal): Promise<boolean> {
    const requestId = `appr_${threadId}_app${this.tag}_${++this.seq}`;
    return new Promise<boolean>((resolve) => {
      let done = false;
      const timer = setTimeout(() => settle('cancel'), timeoutMs);
      timer.unref?.();
      const settle = (d: Decision) => {
        if (done) return;
        done = true; clearTimeout(timer); this.pending.delete(requestId);
        if (d === 'acceptAlways') { try { emit.always?.(); } catch { /* the yes still stands for this call */ } }
        try { emit.resolved(requestId, d); } catch { /* advisory */ }
        resolve(isAllow(d));
      };
      this.pending.set(requestId, { threadId, settle });
      // answered somewhere else first (the live browser panel's bar): retire this card as cancelled
      if (signal) { if (signal.aborted) { settle('cancel'); return; } signal.addEventListener('abort', () => settle('cancel'), { once: true }); }
      try { emit.opened(requestId); } catch { settle('cancel'); }
    });
  }
  /** True when this class owned the request (the caller then must not treat it as its own). */
  respond(threadId: string, requestId: string, decision: string): boolean {
    const p = this.pending.get(requestId);
    if (!p || p.threadId !== threadId) return false;
    p.settle(decision as Decision);
    return true;
  }
  owns(requestId: string): boolean { return this.pending.has(requestId); }
  /** The turn ended or the session stopped: every open question of the thread resolves as cancelled (= denied). */
  cancelThread(threadId: string): void { for (const [, p] of [...this.pending]) if (p.threadId === threadId) p.settle('cancel'); }
  size(): number { return this.pending.size; }
}

/** The `askApproval` a driver hands to a blob's tools: opens an approval card on the thread and parks until it is answered. */
export function askVia(parked: ParkedApprovals, threadId: string, emit: (ev: Record<string, unknown>) => void, turnOf: () => { turnId?: string }) {
  return (p: { title: string; detail: string; args: unknown; always?: { label: string; remember(): void }; signal?: AbortSignal }): Promise<boolean> => parked.ask(threadId, {
    opened: (requestId) => emit({
      type: 'approval.opened', requestId, requestKind: 'mcp_elicitation_approval', title: p.title, detail: p.detail, args: p.args,
      options: [
        { decision: 'accept', label: 'Allow once' },
        ...(p.always ? [{ decision: 'acceptAlways', label: 'Always for this blob' }] : []),
        { decision: 'decline', label: 'Deny' },
      ], ...(p.always ? { alwaysLabel: p.always.label } : {}), ...turnOf(),
    }),
    resolved: (requestId, decision) => emit({ type: 'approval.resolved', requestId, decision }),
    ...(p.always ? { always: () => p.always!.remember() } : {}),
  }, undefined, p.signal);
}
