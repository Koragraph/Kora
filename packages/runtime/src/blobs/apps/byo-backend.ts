// Bring-your-own Composio project key: the daemon talks to Composio directly. No cap, no broker. The key comes from the
// SecretStore on every construction and is only ever sent to the Composio host as `x-api-key`.
import crypto from 'node:crypto';
import { AppsError, MAX_ACCOUNTS_PER_TOOLKIT, type AppAccount, type AppsBackend, type AppTool, type AppToolkit, type ConnectLink, type ExecuteInput } from './types';

export const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3.1';
/** Toolkit versions are pinned like the broker's; bump deliberately. */
export const COMPOSIO_TOOL_VERSION = '00000000_00';
export const LINK_TTL_MS = 10 * 60_000;
export const BYO_KEY_RE = /^ak_[A-Za-z0-9_-]{8,200}$/;

export interface ByoOpts { apiKey: string; installId: string; baseUrl?: string; fetch?: typeof fetch; now?: () => number }

export class ByoBackend implements AppsBackend {
  readonly kind = 'byo' as const;
  private readonly f: typeof fetch;
  private readonly userId: string;
  private session: string | null = null;
  constructor(private readonly o: ByoOpts) {
    this.f = o.fetch ?? fetch;
    // Stable per install, and not guessable from anything else.
    this.userId = 'kora_byo_' + crypto.createHash('sha256').update('byo:' + o.installId).digest('hex').slice(0, 24);
  }

  private async req(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
    let res: Response;
    try {
      res = await this.f((this.o.baseUrl ?? COMPOSIO_API_BASE) + p, {
        method, headers: { accept: 'application/json', 'x-api-key': this.o.apiKey, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new AppsError('upstream', 'Could not reach Composio. Check your connection and try again.'); }
    let json: any = null; try { json = await res.json(); } catch { /* ignore */ }
    if (res.status === 401 || res.status === 403) throw new AppsError('bad_key', 'Composio did not accept your project key. Check it in Settings → Connections.');
    return { status: res.status, json };
  }
  private ok(r: { status: number; json: any }, what: string) {
    if (r.status >= 200 && r.status < 300) return r.json;
    const m = String(r.json?.error?.message ?? r.json?.message ?? `failed (${r.status})`).replaceAll(this.o.apiKey, '[redacted]').slice(0, 300);
    throw new AppsError('upstream', `${what}: ${m}`);
  }

  async usage() { return { used: 0, limit: null, month: new Date((this.o.now ?? Date.now)()).toISOString().slice(0, 7), resetsAt: null }; }
  async toolkits(q: { search?: string; cursor?: string } = {}) {
    const p = new URLSearchParams({ limit: '50' }); if (q.search) p.set('search', q.search); if (q.cursor) p.set('cursor', q.cursor);
    const j = this.ok(await this.req('GET', `/toolkits?${p}`), 'Catalogue');
    return { toolkits: (j.items ?? []).map((t: any): AppToolkit => ({ slug: String(t.slug).toLowerCase(), name: t.name ?? t.slug, description: t.meta?.description ?? '', logo: t.meta?.logo ?? null, categories: (t.meta?.categories ?? []).map((c: any) => c?.name ?? c) })), nextCursor: j.next_cursor ?? null };
  }
  async accounts(toolkit?: string): Promise<AppAccount[]> {
    const p = new URLSearchParams({ limit: '50', user_ids: this.userId }); if (toolkit) p.set('toolkit_slugs', toolkit);
    const j = this.ok(await this.req('GET', `/connected_accounts?${p}`), 'Account lookup');
    const all = (j.items ?? []).filter((a: any) => !a.user_id || a.user_id === this.userId).map((a: any): AppAccount => ({ id: String(a.id), toolkit: String(a.toolkit?.slug ?? '').toLowerCase(), alias: a.alias ?? a.data?.alias ?? null, status: String(a.status ?? 'UNKNOWN') }));
    return toolkit ? all.filter((a: AppAccount) => a.toolkit === toolkit.toLowerCase()) : all;
  }
  async link(toolkit: string, alias?: string): Promise<ConnectLink> {
    const have = await this.accounts(toolkit);
    if (have.length >= MAX_ACCOUNTS_PER_TOOLKIT) throw new AppsError('account_limit', `You can connect up to ${MAX_ACCOUNTS_PER_TOOLKIT} ${toolkit} accounts. Disconnect one first.`);
    if (have.length && !alias) throw new AppsError('alias_required', `Give this ${toolkit} account a label (for example "work") so it does not replace the existing one.`);
    if (alias && have.some((a) => a.alias?.toLowerCase() === alias.toLowerCase())) throw new AppsError('alias_in_use', `A ${toolkit} account labelled "${alias}" already exists.`);
    const payload = { toolkit, ...(alias ? { alias } : {}) };
    const mk = async () => { const j = this.ok(await this.req('POST', '/tool_router/session', { user_id: this.userId }), 'Session'); this.session = String(j.session_id ?? j.id); return this.session; };
    let sid = this.session ?? (await mk());
    let r = await this.req('POST', `/tool_router/session/${encodeURIComponent(sid)}/link`, payload);
    if (r.status === 404) { sid = await mk(); r = await this.req('POST', `/tool_router/session/${encodeURIComponent(sid)}/link`, payload); }
    const j = this.ok(r, 'Connect link');
    let u: URL; try { u = new URL(String(j.redirect_url ?? j.url)); } catch { throw new AppsError('upstream', 'Composio returned no connect link.'); }
    if (u.protocol !== 'https:' || !(u.hostname === 'composio.dev' || u.hostname.endsWith('.composio.dev'))) throw new AppsError('upstream', 'Composio returned an untrusted connect link.');
    const up = Date.parse(String(j.expires_at ?? ''));
    return { url: u.toString(), expiresAt: Math.min((this.o.now ?? Date.now)() + LINK_TTL_MS, Number.isFinite(up) ? up : Infinity) };
  }
  async disconnect(id: string) {
    if (!(await this.accounts()).some((a) => a.id === id)) return { removed: 0 };
    this.ok(await this.req('DELETE', `/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`), 'Disconnect');
    return { removed: 1 };
  }
  async tools(toolkit: string): Promise<AppTool[]> {
    const p = new URLSearchParams({ toolkit_slug: toolkit, limit: '100', toolkit_versions: COMPOSIO_TOOL_VERSION });
    const j = this.ok(await this.req('GET', `/tools?${p}`), 'Tool list');
    return (j.items ?? []).map((t: any): AppTool => ({ slug: String(t.slug), name: t.name ?? t.slug, description: String(t.description ?? '').slice(0, 600), toolkit: String(t.toolkit?.slug ?? toolkit).toLowerCase(), inputSchema: t.input_parameters ?? {}, readOnly: t.tags?.includes?.('readOnlyHint') ? true : null }));
  }
  async execute(i: ExecuteInput) {
    const active = (await this.accounts(i.toolkit)).filter((a) => a.status.toUpperCase() === 'ACTIVE');
    if (!active.length) throw new AppsError('not_connected', `No ${i.toolkit} account is connected.`);
    let acct = active[0];
    if (i.accountId) { const f = active.find((a) => a.id === i.accountId); if (!f) throw new AppsError('unknown_account', 'That account is not connected.'); acct = f; }
    else if (active.length > 1) throw new AppsError('account_required', `Several ${i.toolkit} accounts are connected. Say which one to use.`, { accounts: active.map((a) => ({ id: a.id, alias: a.alias })) });
    const r = await this.req('POST', `/tools/execute/${encodeURIComponent(i.tool)}`, { user_id: this.userId, connected_account_id: acct.id, arguments: i.arguments, version: COMPOSIO_TOOL_VERSION });
    if (r.status >= 500) throw new AppsError('upstream', 'Composio is having trouble. Try again in a moment.');
    if (r.status >= 400) return { ok: false, data: null, error: String(r.json?.error?.message ?? r.json?.message ?? `Rejected (${r.status})`).replaceAll(this.o.apiKey, '[redacted]').slice(0, 300), account: { id: acct.id, alias: acct.alias } };
    const text = JSON.stringify(r.json?.data ?? null).replaceAll(this.o.apiKey, '[redacted]');
    return { ok: r.json?.successful !== false && !r.json?.error, data: JSON.parse(text), error: r.json?.error ? String(typeof r.json.error === 'string' ? r.json.error : r.json.error?.message ?? 'error').replaceAll(this.o.apiKey, '[redacted]').slice(0, 300) : null, account: { id: acct.id, alias: acct.alias } };
  }
}
