// The model-facing app tools: three meta-tools instead of hundreds of per-app ones, so granted tools are *discovered*
// (apps_tools lists only what the blob may use) and the context stays small. A blob with no app grant gets NO tools
// at all, so the model is never told apps exist. Every call re-checks grants inside AppsService.run.
import type { FleetToolSpec } from '../../session/fleet-tools';
import { normalizeGrants } from './grants';
import { msg, type AppsService, type Approver } from './service';
import type { BlobPermission } from '../types';

export interface AppToolContext {
  blobId: string; threadId?: string | null;
  /** Fresh profile reads, never cached by the caller. */
  permission(): BlobPermission;
  grants(): unknown;
  /** The outbound approval. Claude: the SDK permission card; Codex/OpenCode: the daemon pokes the UI (WIRING.md). */
  approve?: Approver;
  /** Show a card in this thread (the Connect / Allow chip when the blob reached for an app it cannot use yet). */
  emitCard?(card: { cardKind: string; cardId: string; version: number; [k: string]: unknown }): void;
}

const ok = (text: string) => ({ text });
const bad = (text: string) => ({ text, isError: true });

export function appToolSpecs(svc: AppsService, ctx: AppToolContext): FleetToolSpec[] {
  // Decided at spec-build time AND re-checked per call: a blob that loses its grant mid-thread gets "no access", not a ghost tool.
  if (normalizeGrants(ctx.grants()).mode === 'none') return [];
  const caller = () => ({ blobId: ctx.blobId, threadId: ctx.threadId ?? null, permission: ctx.permission(), grants: ctx.grants(), ...(ctx.approve ? { approve: ctx.approve } : {}) });

  return [
    {
      name: 'apps_connected',
      description: 'List the apps (Gmail, Calendar, Slack, GitHub...) the user has connected for you, with each account\'s label. Use first when the user asks you to do something in an app. Also shows how many free app calls are left this month.',
      params: {},
      async handler() {
        try {
          const o = await svc.overview(ctx.grants());
          const u = await svc.usage().catch(() => null);
          const usage = u && u.limit !== null ? `\nFree app calls this month: ${u.used}/${u.limit}.` : '';
          if (!o.length) return ok('No apps are connected for you. Tell the user they can connect one in Settings → Connections and allow it for you.' + usage);
          return ok(o.map((t) => `- ${t.toolkit}: ${t.accounts.map((a) => a.alias ?? a.id).join(', ')}`).join('\n') + usage);
        } catch (e) { return bad(msg(e)); }
      },
    },
    {
      name: 'apps_tools',
      description: 'List what you can do in one connected app: exact tool names with their inputs. Only tools you were allowed to use are shown.',
      params: { toolkit: { type: 'string', description: 'the app, for example gmail, googlecalendar, slack, github' } },
      async handler(a) {
        try {
          const tk = String(a.toolkit ?? '').trim().toLowerCase();
          if (!tk) return bad('toolkit is empty');
          const tools = await svc.grantedTools(ctx.grants(), tk);
          if (!tools.length) return ok(`You have no allowed tools in ${tk}.`);
          return ok(tools.map((t) => `${t.slug}: ${t.description.split('\n')[0].slice(0, 160)}\n  inputs: ${JSON.stringify(t.inputSchema?.properties ? Object.fromEntries(Object.entries(t.inputSchema.properties as Record<string, any>).map(([k, v]) => [k, v?.type ?? 'any'])) : {})}${(t.inputSchema as any)?.required?.length ? ` required: ${(t.inputSchema as any).required.join(', ')}` : ''}`).join('\n'));
        } catch (e) { return bad(msg(e)); }
      },
    },
    {
      name: 'apps_run',
      description: 'Run one app tool. Sending, posting, deleting, paying and booking ask the user first - say what you are about to do. When several accounts of the same app are connected you MUST set `account` to one label (ask the user if unclear).',
      params: {
        tool: { type: 'string', description: 'exact tool name from apps_tools, e.g. GMAIL_FETCH_EMAILS' },
        toolkit: { type: 'string', description: 'the app it belongs to, e.g. gmail' },
        arguments_json: { type: 'string', optional: true, description: 'the tool inputs as a JSON object string, e.g. {"max_results": 5}' },
        account: { type: 'string', optional: true, description: 'account label, when more than one is connected' },
      },
      async handler(a) {
        let args: Record<string, unknown> = {};
        const raw = typeof a.arguments_json === 'string' ? a.arguments_json.trim() : '';
        if (raw) { try { const p = JSON.parse(raw); if (!p || typeof p !== 'object' || Array.isArray(p)) throw 0; args = p; } catch { return bad('arguments_json must be a JSON object, for example {"query": "invoices"}'); } }
        const r = await svc.run(caller(), { tool: String(a.tool ?? ''), toolkit: String(a.toolkit ?? ''), arguments: args, ...(typeof a.account === 'string' && a.account ? { account: a.account } : {}) });
        // Not connected / not allowed: say so in the chat as a chip the user can tap (connecting there allows it for this blob).
        if (!r.ok && (r.code === 'not_connected' || r.code === 'not_granted') && ctx.emitCard) {
          const toolkit = String(a.toolkit ?? '').trim().toLowerCase();
          if (/^[a-z0-9_-]{1,64}$/.test(toolkit)) {
            try { ctx.emitCard({ cardKind: 'app-connect', cardId: `app-connect:${ctx.blobId}:${toolkit}`, version: Date.now(), blobId: ctx.blobId, toolkit, reason: r.code }); } catch { /* cards are advisory */ }
          }
        }
        return r.ok ? ok(r.text) : bad(r.text);
      },
    },
  ];
}
