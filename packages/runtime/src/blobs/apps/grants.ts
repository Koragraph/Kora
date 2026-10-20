// Per-blob grants (SPEC: all / exact tool list / none; ungranted tools are never offered to the model).
// BlobToolGrants.apps = { mode: 'none'|'all'|'list', allow: string[] }. In 'list' mode an entry is an exact tool slug
// ("GMAIL_FETCH_EMAILS") or a whole-toolkit shorthand "toolkit:gmail" (the editor's "all of Gmail" toggle).
// Imported blobs and anything missing/garbled get NONE: the check fails closed.

export interface AppGrants { mode: 'none' | 'all' | 'list'; allow: readonly string[] }
export const NO_APP_GRANTS: AppGrants = { mode: 'none', allow: [] };

/** Composio tool slugs are prefixed with the toolkit slug, upper-cased, punctuation removed. */
export const toolkitPrefix = (toolkit: string) => toolkit.toUpperCase().replace(/[^A-Z0-9]/g, '') + '_';
export const toolBelongsTo = (tool: string, toolkit: string) => tool.toUpperCase().startsWith(toolkitPrefix(toolkit));

export function normalizeGrants(g: unknown): AppGrants {
  const o = g as any;
  if (!o || (o.mode !== 'all' && o.mode !== 'list')) return NO_APP_GRANTS;
  return { mode: o.mode, allow: Array.isArray(o.allow) ? o.allow.filter((x: unknown): x is string => typeof x === 'string') : [] };
}

export function allowsTool(grants: unknown, tool: string, toolkit: string): boolean {
  const g = normalizeGrants(grants);
  if (g.mode === 'none') return false;
  if (!toolBelongsTo(tool, toolkit)) return false; // a mislabelled toolkit can never widen a grant
  if (g.mode === 'all') return true;
  const t = tool.toUpperCase();
  return g.allow.some((e) => (e.toLowerCase().startsWith('toolkit:') ? e.slice(8).trim().toLowerCase() === toolkit.toLowerCase() : e.toUpperCase() === t));
}

/** Toolkits this blob may see at all, out of the connected ones. */
export function visibleToolkits(grants: unknown, connected: readonly string[]): string[] {
  const g = normalizeGrants(grants);
  if (g.mode === 'none') return [];
  if (g.mode === 'all') return [...connected];
  return connected.filter((tk) => g.allow.some((e) => (e.toLowerCase().startsWith('toolkit:') ? e.slice(8).trim().toLowerCase() === tk.toLowerCase() : e.toUpperCase().startsWith(toolkitPrefix(tk)))));
}
