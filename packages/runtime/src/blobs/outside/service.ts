// OutsideService: the daemon end of `kora mcp --team`. Two socket methods map onto it (see WIRING.md):
//   blobs.outside.hello { token, clientInfo? } -> { ok, client, tools:[{name,description,params}] } | { ok:false, error }
//   blobs.outside.call  { token, tool, args, clientInfo? } -> { text, isError?, timeoutS? }
// plus the token/audit surface the Settings page uses. Every call - allowed or refused - lands in the audit log.
import { AuditLog } from './audit';
import { RateLimiter } from './ratelimit';
import { TokenStore, type VerifyResult } from './tokens';
import { toolDefs, validateArgs, type ToolDef } from './tools';
import type { AuditRow, OutsideHost, OutsideToolResult, TokenRecord } from './types';

export interface OutsideServiceOptions {
  host: OutsideHost;
  tokens?: TokenStore;
  audit?: AuditLog;
  limiter?: RateLimiter;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface HelloReply { ok: boolean; client?: string; tools?: Array<{ name: string; description: string; params: ToolDef['params']; maxSeconds?: number }>; error?: string }

const INVALID = 'This Kora token is not valid. Create a new one in Kora, Settings, Outside access.';
const REVOKED = 'This Kora token was revoked. Create a new one in Kora, Settings, Outside access.';

export class OutsideService {
  readonly tokens: TokenStore;
  readonly audit: AuditLog;
  readonly limiter: RateLimiter;
  private readonly host: OutsideHost;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(o: OutsideServiceOptions) {
    this.host = o.host;
    this.now = o.now ?? Date.now;
    this.tokens = o.tokens ?? new TokenStore(undefined, this.now);
    this.audit = o.audit ?? new AuditLog(undefined, this.now);
    this.limiter = o.limiter ?? new RateLimiter(undefined, this.now);
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private refusal(v: Extract<VerifyResult, { ok: false }>, tool: string): string {
    this.audit.append({ tokenId: v.record?.id ?? 'unknown', client: v.record?.name ?? '(unknown token)', tool, ok: false, note: v.reason === 'revoked' ? 'revoked token' : 'unknown token' });
    return v.reason === 'revoked' ? REVOKED : INVALID;
  }

  hello(i: { token: string }): HelloReply {
    const v = this.tokens.verify(i.token);
    if (!v.ok) return { ok: false, error: this.refusal(v, 'hello') };
    return { ok: true, client: v.record.name, tools: toolDefs(this.host).map((t) => ({ name: t.name, description: t.description, params: t.params, ...(t.maxSeconds ? { maxSeconds: t.maxSeconds } : {}) })) };
  }

  async call(i: { token: string; tool: string; args?: unknown; clientInfo?: { name?: string; version?: string } }): Promise<OutsideToolResult> {
    const v = this.tokens.verify(i.token);
    if (!v.ok) return { text: this.refusal(v, String(i.tool).slice(0, 40)), isError: true };
    const rec = v.record;
    const log = (ok: boolean, target: string | null, note: string | null = null) => this.audit.append({ tokenId: rec.id, client: rec.name, tool: String(i.tool).slice(0, 40), target, ok, note: note ?? (i.clientInfo?.name ? `via ${String(i.clientInfo.name).slice(0, 40)}` : null) });
    const def = toolDefs(this.host).find((t) => t.name === i.tool);
    if (!def) { log(false, null, 'unknown tool'); return { text: `No tool "${String(i.tool).slice(0, 40)}" is available over outside access.`, isError: true }; }
    const wait = this.limiter.take(rec.id, def.send === true);
    if (wait !== null) { log(false, null, 'rate limited'); return { text: `Rate limit reached for this token. Try again in ${wait}s.`, isError: true }; }
    const checked = validateArgs(def.params, i.args);
    if ('error' in checked) { log(false, null, 'bad arguments'); return { text: `${def.name}: ${checked.error}`, isError: true }; }
    this.tokens.touch(rec.id);
    const target = def.target(checked.args);
    try {
      const r = await def.run({ host: this.host, via: { client: rec.name, tokenId: rec.id }, sleep: this.sleep, now: this.now }, checked.args);
      log(!r.isError, target, r.isError ? r.text.slice(0, 120) : null);
      return { text: r.text, ...(r.isError ? { isError: true } : {}) };
    } catch (e: any) {
      log(false, target, `error: ${String(e?.message ?? e).slice(0, 100)}`);
      return { text: `Kora could not complete ${def.name}: ${String(e?.message ?? e)}`, isError: true };
    }
  }

  // ---- the Settings page surface (ui-server RPCs call these) ----
  listTokens(): TokenRecord[] { return this.tokens.list(); }
  createToken(name: string) { return this.tokens.create(name); }
  revokeToken(id: string): boolean { const ok = this.tokens.revoke(id); if (ok) this.limiter.forget(id); return ok; }
  auditPage(o: { limit?: number; before?: number; tokenId?: string } = {}): { rows: AuditRow[]; next: number | null } { return this.audit.list(o); }
}
