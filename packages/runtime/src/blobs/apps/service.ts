// AppsService: the one object the runtime holds for connected apps. Picks the backend (BYO key beats the broker),
// filters tools by the blob's grants, gates outbound actions behind an approval, writes the decision log and turns
// every failure into a clear, secret-free message. Handlers never throw; they return AppRunResult.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppsError, CAP_MESSAGE, type AppAccount, type AppTool, type AppToolkit, type AppUsage, type AppsBackend, type AppsMode, type ConnectLink } from './types';
import { ByoBackend, BYO_KEY_RE } from './byo-backend';
import { BrokerBackend, BROKER_TOKEN_SECRET } from './broker-backend';
import type { SecretStore } from './secrets';
import { DecisionLog, argFingerprint, type DecisionReason } from './decision-log';
import { allowsTool, normalizeGrants, toolBelongsTo, visibleToolkits } from './grants';
import { classifyTool } from './classify';

export const BYO_KEY_SECRET = 'composio-byo-key';
const TOOLS_TTL_MS = 5 * 60_000;

export interface ApprovalRequest {
  blobId: string; threadId: string | null; tool: string; toolkit: string;
  account: { id: string; alias: string | null } | null;
  /** Plain words for the card: "Send an email as work@acme.com". */
  summary: string; reason: string;
  /** Truncated arguments, for the user to read. Shown, never logged. */
  argsPreview: string;
  /** The raw arguments, for building the card's one-line summary in memory. Never logged, never stored. */
  args: Record<string, unknown>;
}
export type Approver = (req: ApprovalRequest) => Promise<boolean>;

export interface AppsCaller {
  blobId: string; threadId?: string | null;
  permission: 'ask' | 'auto' | 'full';
  /** BlobToolGrants.apps, read fresh from the profile on every call. */
  grants: unknown;
  /** Resolves true when the user allows. Absent = outbound actions are refused (fail closed). */
  approve?: Approver;
}

export interface AppRunResult {
  ok: boolean;
  text: string;
  code?: string;
  data?: unknown;
  /** True when the call counted against the monthly cap. */
  usage?: { used: number; limit: number | null };
}

export interface AppsServiceDeps {
  /** <KORA_HOME>/blobs/apps */
  dir: string;
  secrets: SecretStore;
  /** Kora's broker (baked into the build / KORA_COMPOSIO_BROKER_URL). Absent = BYO only. */
  brokerUrl?: string;
  /** Composio's own API base for a pasted key (the QA stacks point it at a fake; default: Composio). */
  byoBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Test seam. */
  makeBackend?: (kind: 'broker' | 'byo', key?: string) => AppsBackend;
}

interface State { installId: string; capUntil?: number; capUsed?: number; capLimit?: number }

export class AppsService {
  readonly decisions: DecisionLog;
  private readonly now: () => number;
  private cached: { key: string; backend: AppsBackend } | null = null;
  private toolCache = new Map<string, { at: number; tools: AppTool[] }>();

  constructor(private readonly d: AppsServiceDeps) {
    this.now = d.now ?? Date.now;
    this.decisions = new DecisionLog(path.join(d.dir, 'decisions.jsonl'));
  }

  // ---- state ----
  private readState(): State {
    try { const s = JSON.parse(fs.readFileSync(path.join(this.d.dir, 'state.json'), 'utf8')); if (typeof s.installId === 'string') return s; } catch { /* first run */ }
    const s: State = { installId: 'kora_' + crypto.randomBytes(8).toString('hex') };
    this.writeState(s);
    return s;
  }
  private writeState(s: State) { try { fs.mkdirSync(this.d.dir, { recursive: true }); fs.writeFileSync(path.join(this.d.dir, 'state.json'), JSON.stringify(s), { mode: 0o600 }); } catch { /* advisory */ } }

  private noteCap(used: number, limit: number, resetsAt: number | null) {
    const s = this.readState(); s.capUntil = resetsAt ?? monthEnd(this.now()); s.capUsed = used; s.capLimit = limit; this.writeState(s);
  }

  // ---- backend selection: BYO key > broker ----
  async mode(): Promise<AppsMode> {
    if (await this.d.secrets.get(BYO_KEY_SECRET)) return 'byo';
    return this.d.brokerUrl ? 'broker' : 'unavailable';
  }
  async backend(): Promise<AppsBackend> {
    const byo = await this.d.secrets.get(BYO_KEY_SECRET);
    const key = byo ? 'byo:' + byo : this.d.brokerUrl ? 'broker' : '';
    if (!key) throw new AppsError('not_configured', 'Connected apps are not set up yet. Paste your own Composio key in Settings → Connections.');
    if (this.cached?.key === key) return this.cached.backend;
    const backend = byo
      ? (this.d.makeBackend?.('byo', byo) ?? new ByoBackend({ apiKey: byo, installId: this.readState().installId, ...(this.d.byoBaseUrl ? { baseUrl: this.d.byoBaseUrl } : {}), fetch: this.d.fetch, now: this.now }))
      : (this.d.makeBackend?.('broker') ?? new BrokerBackend({ baseUrl: this.d.brokerUrl!, secrets: this.d.secrets, fetch: this.d.fetch, now: this.now }));
    this.cached = { key, backend };
    return backend;
  }

  // ---- Settings -> Connections ----
  /** Validates the key against Composio BEFORE storing it, so a typo never replaces a working setup. */
  async setByoKey(key: string): Promise<void> {
    const k = key.trim();
    if (!BYO_KEY_RE.test(k)) throw new AppsError('bad_key', 'That does not look like a Composio project key (it starts with ak_).');
    await new ByoBackend({ apiKey: k, installId: this.readState().installId, ...(this.d.byoBaseUrl ? { baseUrl: this.d.byoBaseUrl } : {}), fetch: this.d.fetch, now: this.now }).accounts();
    await this.d.secrets.set(BYO_KEY_SECRET, k);
    this.cached = null; this.toolCache.clear();
    const s = this.readState(); delete s.capUntil; delete s.capUsed; delete s.capLimit; this.writeState(s);
  }
  async clearByoKey(): Promise<void> { await this.d.secrets.delete(BYO_KEY_SECRET); this.cached = null; this.toolCache.clear(); }
  /** Forget the broker identity (a new registration is a new Composio user: existing connections are lost). */
  async resetBroker(): Promise<void> { await this.d.secrets.delete(BROKER_TOKEN_SECRET); this.cached = null; }

  async usage(): Promise<AppUsage> {
    const mode = await this.mode();
    if (mode === 'unavailable') return { mode, used: 0, limit: null, month: new Date(this.now()).toISOString().slice(0, 7), resetsAt: null, capReached: false };
    const u = await (await this.backend()).usage();
    const capReached = u.limit !== null && u.used >= u.limit;
    if (capReached && u.limit !== null) this.noteCap(u.used, u.limit, u.resetsAt);
    else {
      // the broker says there are calls left (the owner raised the monthly cap, or the month turned): drop the local "used up" memory,
      // or this Mac would keep refusing until the old reset date
      const st = this.readState();
      if (st.capUntil) { delete st.capUntil; delete st.capUsed; delete st.capLimit; this.writeState(st); }
    }
    return { mode, ...u, capReached };
  }
  async status() {
    const mode = await this.mode();
    let usage: AppUsage | null = null, error: string | null = null, errorCode: string | null = null;
    if (mode !== 'unavailable') { try { usage = await this.usage(); } catch (e) { error = msg(e); errorCode = e instanceof AppsError ? e.code : 'upstream'; } }
    return { mode, byoKeySet: mode === 'byo', brokerConfigured: !!this.d.brokerUrl, secretStore: this.d.secrets.kind, usage, error, errorCode };
  }

  async toolkits(q?: { search?: string; cursor?: string }): Promise<{ toolkits: AppToolkit[]; nextCursor: string | null }> { return (await this.backend()).toolkits(q); }
  async accounts(toolkit?: string): Promise<AppAccount[]> { return (await this.backend()).accounts(toolkit); }
  async disconnect(accountId: string) { const r = await (await this.backend()).disconnect(accountId); this.toolCache.clear(); return r; }

  /** A Connect link for the UI to open in the browser. Never log it or put it in a chat message. */
  async connect(toolkit: string, alias?: string): Promise<ConnectLink> { return (await this.backend()).link(toolkit, alias?.trim() || undefined); }
  linkIsFresh(l: ConnectLink): boolean { return this.now() < l.expiresAt; }
  /** Throws link_expired when the link is stale: the UI must ask for a new one rather than open a dead page. */
  assertLinkFresh(l: ConnectLink): ConnectLink { if (!this.linkIsFresh(l)) throw new AppsError('link_expired', 'That connect link has expired. Start again to get a new one.'); return l; }
  /** Poll until an ACTIVE account that was not in `before` shows up (the OAuth round trip finished). */
  async waitForConnection(toolkit: string, before: readonly AppAccount[], o: { timeoutMs?: number; pollMs?: number } = {}): Promise<AppAccount | null> {
    const seen = new Set(before.map((a) => a.id));
    const end = this.now() + (o.timeoutMs ?? 120_000);
    for (;;) {
      const now = (await this.accounts(toolkit)).find((a) => !seen.has(a.id) && a.status.toUpperCase() === 'ACTIVE');
      if (now) return now;
      if (this.now() >= end) return null;
      await new Promise((r) => setTimeout(r, o.pollMs ?? 2000));
    }
  }

  // ---- what a blob may see ----
  /** Connected toolkits visible to this blob, with their accounts. Empty when the blob has no app grant. */
  async overview(grants: unknown): Promise<{ toolkit: string; accounts: { id: string; alias: string | null }[] }[]> {
    if (normalizeGrants(grants).mode === 'none') return [];
    const active = (await this.accounts()).filter((a) => a.status.toUpperCase() === 'ACTIVE');
    const by = new Map<string, AppAccount[]>();
    for (const a of active) by.set(a.toolkit, [...(by.get(a.toolkit) ?? []), a]);
    return visibleToolkits(grants, [...by.keys()]).map((tk) => ({ toolkit: tk, accounts: by.get(tk)!.map((a) => ({ id: a.id, alias: a.alias })) }));
  }
  /** The tools of one toolkit this blob is granted: ungranted ones are dropped here, so they never reach the model. */
  async grantedTools(grants: unknown, toolkit: string): Promise<AppTool[]> {
    if (normalizeGrants(grants).mode === 'none') return [];
    const key = (await this.mode()) + ':' + toolkit;
    let hit = this.toolCache.get(key);
    if (!hit || this.now() - hit.at > TOOLS_TTL_MS) { hit = { at: this.now(), tools: await (await this.backend()).tools(toolkit) }; this.toolCache.set(key, hit); }
    return hit.tools.filter((t) => allowsTool(grants, t.slug, toolkit));
  }

  /** The owner's view of a toolkit's tools (the per-blob grants editor): everything, ungated, with the "asks first" flag. */
  async ownerTools(toolkit: string): Promise<Array<AppTool & { outbound: boolean }>> {
    const tools = await (await this.backend()).tools(toolkit.trim().toLowerCase());
    return tools.map((t) => ({ ...t, outbound: classifyTool(t.slug, { readOnly: t.readOnly }).outbound }));
  }

  // ---- running a tool ----
  async run(c: AppsCaller, call: { tool: string; toolkit: string; arguments: Record<string, unknown>; account?: string }): Promise<AppRunResult> {
    const tool = call.tool.trim(), toolkit = call.toolkit.trim().toLowerCase();
    const fp = argFingerprint(call.arguments ?? {});
    let account: { id: string; alias: string | null } | null = null;
    const mode = await this.mode().catch(() => 'unavailable' as AppsMode);
    const row = (kind: 'decision' | 'result', decision: 'allow' | 'deny', reason: DecisionReason, outbound: boolean, outcome?: string) =>
      this.decisions.append({ at: this.now(), kind, blobId: c.blobId, threadId: c.threadId ?? null, tool, toolkit, account: account?.alias ?? account?.id ?? null, decision, reason, outbound, mode, ...fp, ...(outcome ? { outcome } : {}) });
    const deny = (reason: DecisionReason, code: string, text: string, outbound = false): AppRunResult => { row('decision', 'deny', reason, outbound); return { ok: false, code, text }; };

    try {
      if (!/^[A-Za-z0-9_]{1,128}$/.test(tool) || !/^[a-z0-9_-]{1,64}$/.test(toolkit) || !toolBelongsTo(tool, toolkit)) return deny('bad_request', 'bad_request', 'That tool name and app do not match. Use apps_tools to see the exact names.');
      // 1. grants - re-read by the caller on every call; the model's say-so counts for nothing.
      if (!allowsTool(c.grants, tool, toolkit)) return deny('not_granted', 'not_granted', `You do not have access to ${tool}. Ask the user to allow it in your settings (Tools & apps).`);
      // 2. local cap short-circuit: once the broker said the month is spent, do not call it again until it resets.
      const st = this.readState();
      if (st.capUntil && this.now() < st.capUntil && mode === 'broker') { return deny('cap_reached', 'cap_reached', CAP_MESSAGE(st.capUsed ?? 0, st.capLimit ?? 0, st.capUntil)); }
      if (st.capUntil && this.now() >= st.capUntil) { delete st.capUntil; delete st.capUsed; delete st.capLimit; this.writeState(st); }

      const backend = await this.backend();
      // 3. account: explicit selection. A label or id from the model is resolved against the install's own accounts.
      let accountId: string | undefined;
      if (call.account?.trim()) {
        const ref = call.account.trim().toLowerCase();
        const list = (await backend.accounts(toolkit)).filter((a) => a.status.toUpperCase() === 'ACTIVE');
        const hit = list.find((a) => a.id.toLowerCase() === ref || a.alias?.toLowerCase() === ref);
        if (!hit) return deny(list.length ? 'account_required' : 'not_connected', list.length ? 'unknown_account' : 'not_connected', list.length ? `No ${toolkit} account called "${call.account}". Connected: ${list.map(label).join(', ')}.` : `No ${toolkit} account is connected. Ask the user to connect it in Settings → Connections.`);
        accountId = hit.id; account = { id: hit.id, alias: hit.alias };
      }
      // 4. outbound rule: sending/posting/deleting/paying/booking always asks, even on Auto. Only Full access skips it.
      const cls = classifyTool(tool, { readOnly: (await this.knownTool(toolkit, tool))?.readOnly ?? null });
      let skippedFull = false;
      if (cls.outbound) {
        if (c.permission === 'full') skippedFull = true;
        else if (!c.approve) return deny('no_approval_channel', 'denied', `${tool} would change something outside Kora and needs the user's OK, but there is no way to ask right now. Tell the user what you wanted to do.`, true);
        else {
          // name the account on the card when there is only one to mean ("Send email (work)"); with several, the model had to pick one above
          if (!account) {
            try {
              const act = (await backend.accounts(toolkit)).filter((a) => a.status.toUpperCase() === 'ACTIVE');
              if (act.length === 1) account = { id: act[0]!.id, alias: act[0]!.alias };
            } catch { /* the card simply carries no account name */ }
          }
          let ok = false;
          try { ok = await c.approve({ blobId: c.blobId, threadId: c.threadId ?? null, tool, toolkit, account, summary: `${humanize(tool)}${account ? ` (${label(account)})` : ''}`, reason: cls.reason, argsPreview: preview(call.arguments), args: call.arguments ?? {} }); } catch { ok = false; }
          if (!ok) return deny('user_denied', 'denied', `The user said no to ${humanize(tool)}. Do not retry it; ask what they would like instead.`, true);
        }
      }
      row('decision', 'allow', skippedFull ? 'full_access_skip' : cls.outbound ? 'user_approved' : 'granted', cls.outbound);

      // 5. run
      let r;
      try { r = await backend.execute({ tool, toolkit, arguments: call.arguments ?? {}, ...(accountId ? { accountId } : {}) }); }
      catch (e) {
        if (e instanceof AppsError) {
          if (e.code === 'cap_reached') this.noteCap(Number(e.details.used ?? 0), Number(e.details.limit ?? 0), typeof e.details.resetsAt === 'number' ? e.details.resetsAt : null);
          row('result', 'allow', 'granted', cls.outbound, e.code);
          if (e.code === 'account_required') return { ok: false, code: e.code, text: `Several ${toolkit} accounts are connected: ${((e.details.accounts as any[]) ?? []).map(label).join(', ')}. Run again with account set to one of these labels; if the user did not say which, ask them.` };
          return { ok: false, code: e.code, text: e.message };
        }
        throw e;
      }
      account = r.account ?? account;
      row('result', 'allow', 'granted', cls.outbound, r.ok ? 'ok' : 'error');
      if (r.usage?.limit != null && r.usage.used >= r.usage.limit) this.noteCap(r.usage.used, r.usage.limit, monthEnd(this.now()));
      if (!r.ok) return { ok: false, code: 'tool_error', text: `${tool} failed: ${r.error ?? 'unknown error'}`, ...(r.usage ? { usage: r.usage } : {}) };
      return { ok: true, text: clip(typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? null)), data: r.data, ...(r.usage ? { usage: r.usage } : {}) };
    } catch (e) {
      const text = msg(e);
      return { ok: false, code: e instanceof AppsError ? e.code : 'upstream', text };
    }
  }

  private async knownTool(toolkit: string, tool: string): Promise<AppTool | undefined> {
    const hit = this.toolCache.get((await this.mode()) + ':' + toolkit);
    return hit?.tools.find((t) => t.slug.toUpperCase() === tool.toUpperCase());
  }
}

const monthEnd = (t: number) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };
const label = (a: { id: string; alias?: string | null }) => a.alias ? `"${a.alias}"` : a.id;
const humanize = (slug: string) => slug.split('_').slice(1).join(' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) + ' on ' + slug.split('_')[0].toLowerCase();
const preview = (a: Record<string, unknown>) => { try { const s = JSON.stringify(a ?? {}, null, 1); return s.length > 600 ? s.slice(0, 600) + '…' : s; } catch { return ''; } };
const clip = (s: string) => (s.length > 24_000 ? s.slice(0, 24_000) + '\n…[truncated; ask for fewer fields or a narrower search]' : s);
export function msg(e: unknown): string { return e instanceof AppsError ? e.message : 'Connected apps hit an unexpected error. Try again; if it keeps happening, check Settings → Connections.'; }
