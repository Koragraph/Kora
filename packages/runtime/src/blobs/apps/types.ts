// Connected apps (Phase 5): shared types. See docs/bots/APPS.md. No imports from contracts (runtime never imports it).

export type AppsMode = 'byo' | 'broker' | 'unavailable';

export type AppsErrorCode =
  | 'cap_reached' | 'rate_limited' | 'broker_down' | 'registration_closed' | 'unauthorized' | 'bad_key'
  | 'account_required' | 'not_connected' | 'account_limit' | 'alias_required' | 'alias_in_use' | 'unknown_account'
  | 'not_granted' | 'denied' | 'link_expired' | 'bad_request' | 'upstream' | 'not_configured';

export class AppsError extends Error {
  readonly code: AppsErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: AppsErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AppsError';
    this.code = code;
    this.details = details;
  }
}

export interface AppAccount { id: string; toolkit: string; alias: string | null; status: string }
export interface AppTool { slug: string; name: string; description: string; toolkit: string; inputSchema: Record<string, unknown>; readOnly: boolean | null }
export interface AppToolkit { slug: string; name: string; description: string; logo: string | null; categories: string[] }
export interface ConnectLink { url: string; expiresAt: number }

export interface AppUsage {
  mode: AppsMode;
  used: number;
  /** null = unlimited (BYO key). */
  limit: number | null;
  month: string;
  resetsAt: number | null;
  capReached: boolean;
}

export interface ExecuteResult { ok: boolean; data: unknown; error: string | null; account: { id: string; alias: string | null } | null }

export interface ExecuteInput { tool: string; toolkit: string; arguments: Record<string, unknown>; accountId?: string }

/** One transport to Composio: the Kora broker, or Composio directly with the user's own project key. */
export interface AppsBackend {
  readonly kind: 'broker' | 'byo';
  usage(): Promise<{ used: number; limit: number | null; month: string; resetsAt: number | null }>;
  toolkits(q?: { search?: string; cursor?: string }): Promise<{ toolkits: AppToolkit[]; nextCursor: string | null }>;
  accounts(toolkit?: string): Promise<AppAccount[]>;
  link(toolkit: string, alias?: string): Promise<ConnectLink>;
  disconnect(accountId: string): Promise<{ removed: number }>;
  tools(toolkit: string): Promise<AppTool[]>;
  execute(i: ExecuteInput): Promise<ExecuteResult & { usage?: { used: number; limit: number | null } }>;
}

export const MAX_ACCOUNTS_PER_TOOLKIT = 5;
export const CAP_MESSAGE = (used: number, limit: number, resetsAt: number | null) =>
  `Monthly free app calls used up (${used}/${limit}). Upgrade to Kora Pro (coming soon)` +
  `${resetsAt ? `, or wait until ${new Date(resetsAt).toISOString().slice(0, 10)} when they reset` : ''}. ` +
  `You can also paste your own Composio key in Settings → Connections for unlimited calls.`;
export const BROKER_DOWN_MESSAGE =
  'Connected apps are unreachable right now (Kora\'s app service is down, or this Mac is offline). Nothing was used from your monthly calls. Everything else in Kora still works; try again in a moment.';
