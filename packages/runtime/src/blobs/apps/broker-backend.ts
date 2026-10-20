// The Kora broker transport (services/composio-broker). One bearer token per install, kept in the SecretStore.
// Any network failure, timeout or 5xx becomes the single clear "apps unreachable" error: no stack, no URL, no key.
import { AppsError, BROKER_DOWN_MESSAGE, CAP_MESSAGE, type AppAccount, type AppsBackend, type AppTool, type AppToolkit, type AppsErrorCode, type ConnectLink, type ExecuteInput } from './types';
import type { SecretStore } from './secrets';

export const BROKER_TOKEN_SECRET = 'broker-token';

export interface BrokerOpts { baseUrl: string; secrets: SecretStore; fetch?: typeof fetch; timeoutMs?: number; now?: () => number }

const KNOWN: ReadonlySet<string> = new Set<AppsErrorCode>(['cap_reached', 'rate_limited', 'registration_closed', 'unauthorized', 'account_required', 'not_connected', 'account_limit', 'alias_required', 'alias_in_use', 'unknown_account', 'bad_request']);

export class BrokerBackend implements AppsBackend {
  readonly kind = 'broker' as const;
  private readonly f: typeof fetch;
  private registering: Promise<string> | null = null;
  constructor(private readonly o: BrokerOpts) { this.f = o.fetch ?? fetch; }

  private url(p: string) { return this.o.baseUrl.replace(/\/+$/, '') + p; }

  private async raw(method: string, p: string, token: string | null, body?: unknown): Promise<{ status: number; json: any }> {
    let res: Response;
    try {
      res = await this.f(this.url(p), {
        method,
        headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
    } catch { throw new AppsError('broker_down', BROKER_DOWN_MESSAGE); }
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON: handled by status below */ }
    if (res.status >= 500 && !json?.error?.code) throw new AppsError('broker_down', BROKER_DOWN_MESSAGE);
    return { status: res.status, json };
  }

  /** Register once (single-flight): the token is shown by the broker exactly once. */
  private token(): Promise<string> {
    return (this.registering ??= (async () => {
      try {
        const have = await this.o.secrets.get(BROKER_TOKEN_SECRET);
        if (have) return have;
        const r = await this.raw('POST', '/v1/register', null, {});
        if (r.status !== 201 || typeof r.json?.token !== 'string') throw this.toError(r);
        await this.o.secrets.set(BROKER_TOKEN_SECRET, r.json.token);
        return r.json.token as string;
      } finally { this.registering = null; }
    })());
  }

  private toError(r: { status: number; json: any }): AppsError {
    const e = r.json?.error;
    const code = String(e?.code ?? '');
    if (code === 'cap_reached') return new AppsError('cap_reached', CAP_MESSAGE(Number(e.used ?? 0), Number(e.limit ?? 0), typeof e.resetsAt === 'number' ? e.resetsAt : null), { used: e.used, limit: e.limit, resetsAt: e.resetsAt });
    if (code === 'registration_closed') return new AppsError('registration_closed', String(e.message));
    if (KNOWN.has(code)) return new AppsError(code as AppsErrorCode, String(e.message ?? code), { ...(e.accounts ? { accounts: e.accounts } : {}), ...(e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {}) });
    if (r.status === 401) return new AppsError('unauthorized', 'Kora\'s app service did not accept this install. Reset the connection in Settings → Connections.');
    return new AppsError('upstream', String(e?.message ?? `The app service said no (${r.status}).`).slice(0, 300));
  }

  private async call(method: string, p: string, body?: unknown): Promise<any> {
    const token = await this.token();
    const r = await this.raw(method, p, token, body);
    if (r.status >= 200 && r.status < 300) return r.json;
    throw this.toError(r);
  }

  async usage() { const j = await this.call('GET', '/v1/usage'); return { used: j.used, limit: j.limit as number, month: j.month, resetsAt: j.resetsAt as number }; }
  async toolkits(q: { search?: string; cursor?: string } = {}) {
    const p = new URLSearchParams(); if (q.search) p.set('search', q.search); if (q.cursor) p.set('cursor', q.cursor);
    const j = await this.call('GET', `/v1/toolkits${p.size ? '?' + p : ''}`);
    return { toolkits: (j.toolkits ?? []) as AppToolkit[], nextCursor: (j.nextCursor ?? null) as string | null };
  }
  async accounts(toolkit?: string): Promise<AppAccount[]> { return (await this.call('GET', `/v1/accounts${toolkit ? '?toolkit=' + encodeURIComponent(toolkit) : ''}`)).accounts; }
  async link(toolkit: string, alias?: string): Promise<ConnectLink> { const j = await this.call('POST', '/v1/link', { toolkit, ...(alias ? { alias } : {}) }); return { url: j.url, expiresAt: j.expiresAt }; }
  async disconnect(id: string) { return this.call('DELETE', `/v1/accounts/${encodeURIComponent(id)}`) as Promise<{ removed: number }>; }
  async tools(toolkit: string): Promise<AppTool[]> { return (await this.call('GET', `/v1/tools?toolkit=${encodeURIComponent(toolkit)}`)).tools; }
  async execute(i: ExecuteInput) {
    const j = await this.call('POST', '/v1/execute', { tool: i.tool, toolkit: i.toolkit, arguments: i.arguments, ...(i.accountId ? { account_id: i.accountId } : {}) });
    return { ok: !!j.ok, data: j.data ?? null, error: j.error ?? null, account: j.account ?? null, usage: j.usage ? { used: j.usage.used, limit: j.usage.limit } : undefined };
  }
}
