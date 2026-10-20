// Safety rules of the blob browser. They live in the tool host, NOT in the CLI's permission mode (Claude's auto /
// bypass modes would skip any CLI-side prompt): an outbound action blocks on an approval the model cannot grant
// itself, secret fields are never read, file:// and downloads are denied.
// Everything here is pure or takes an injected callback so it is unit-testable without a browser.

/** What the page script's `describe(el)` reports about an element about to be clicked / submitted. */
export interface ElementInfo {
  tag: string;
  type: string;
  label: string;
  isSubmit: boolean;
  form: { action: string; method: string; nFields: number; secretInForm: boolean; cardInForm: boolean } | null;
  href: string | null;
  download?: boolean;
  secret: boolean;
  disabled?: boolean;
  editable: boolean;
}

const HARD_RISK = /\b(pay(ment)?|place (your )?order|complete (purchase|order|booking)|purchase|confirm (order|booking|payment|purchase)|donate|delete|remove|send|post|publish|submit|transfer|withdraw|unsubscribe|sign ?in|log ?in|sign ?up|register|checkout|check out)\b/i;
const SOFT_RISK = /\b(buy|book|reserve|order|subscribe|apply)\b/i;
const HARD_HREF = /\/(checkout|payment|pay|cart\/confirm)\b/i;

export type RiskLevel = 'none' | 'soft' | 'hard';
export interface Risk { level: RiskLevel; summary: string }

/**
 * Hard (blocks until the user approves): a submit in a form that holds a password/card field, any POST form submit,
 * a submit/button whose text says pay / place order / purchase / send / post / delete / sign in / register / checkout
 * ..., a link to /checkout or /payment. Soft (allowed, the result tells the agent to confirm before the final
 * submit): buy / book / reserve / subscribe on non-form links, so browsing showtimes works. GET search forms pass.
 * It is a heuristic over text + form semantics: it will miss a `div` that submits via fetch under an innocent label;
 * the network backstop in the hardening slice covers that.
 */
export function classifyOutbound(info: ElementInfo, how: string, host: string): Risk {
  const label = info.label || '';
  const text = `${label} ${info.form?.action ?? ''} ${info.href ?? ''}`;
  const hard =
    (!!info.form?.cardInForm && info.isSubmit) ||
    (info.isSubmit && (!!info.form?.secretInForm || info.form?.method === 'post' || HARD_RISK.test(text))) ||
    (!info.isSubmit && HARD_RISK.test(label) && !/^(search|find)/i.test(label) && info.tag !== 'A') ||
    (info.tag === 'A' && HARD_HREF.test(info.href ?? ''));
  const summary = `${how} "${label}"${info.form ? ` (form ${info.form.method.toUpperCase()} ${info.form.action})` : ''} on ${host}`;
  if (hard) return { level: 'hard', summary };
  return { level: SOFT_RISK.test(label) ? 'soft' : 'none', summary };
}

export interface BrowserApprovalRequest {
  id: string;
  blobId: string;
  /** Human sentence for the approval card: what is about to happen and where. */
  summary: string;
  /** Page url at the time of the request. */
  url: string;
  /** Aborted once the approval is settled somewhere else (the live panel's inline bar), so the blobs approvals card can retire itself. */
  signal?: AbortSignal;
}
export type RequestApproval = (req: BrowserApprovalRequest) => Promise<boolean>;

/** Ask the injected callback. Missing callback, a throw, or no answer within `timeoutMs` all mean deny. */
export async function askApproval(fn: RequestApproval | undefined, req: BrowserApprovalRequest, timeoutMs: number): Promise<boolean> {
  if (!fn) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(req).then((v) => v === true),
      denyAfter(timeoutMs, req.signal, (t) => { timer = t; }),
    ]);
  } catch { return false; } finally { if (timer) clearTimeout(timer); }
}

/**
 * Resolves false after `ms`: the "no answer = deny". The timer is not unref'd, because it must fire even when nothing
 * else keeps the process alive (an unref'd one left a silent approval pending forever). `signal` (aborted once the
 * approval settled elsewhere, e.g. the live panel won the race) clears it at once, so a lost race leaves no timer behind.
 */
export function denyAfter(ms: number, signal?: AbortSignal, onTimer?: (t: NodeJS.Timeout) => void): Promise<boolean> {
  return new Promise<boolean>((r) => {
    if (signal?.aborted) return r(false);
    const t = setTimeout(() => r(false), ms);
    onTimer?.(t);
    signal?.addEventListener('abort', () => { clearTimeout(t); r(false); }, { once: true });
  });
}

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/** Agent navigation is http(s) only: no file:, javascript:, chrome:, data:, blob:, ftp:. */
export function checkNavigableUrl(raw: string): UrlCheck {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'invalid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `${u.protocol} URLs are not allowed (only http/https)` };
  if (u.username || u.password) return { ok: false, reason: 'URLs with embedded credentials are not allowed' };
  return { ok: true, url: u.href };
}

/** A frame that ended up on a local-file URL (a redirect or a click we did not foresee). */
export const isFileUrl = (url: string): boolean => /^file:/i.test(url);

export const FILE_BLOCKED_NOTE = 'file:// is blocked';
export const SECRET_TYPE_DENIED = 'DENIED: this is a password/card/secret field. Ask the user to take over the browser and type it themselves; you will not see it.';
export const SCREENSHOT_DENIED = 'DENIED: a password/secret field is focused or filled on this page, so screenshots are disabled. Use browser_snapshot (secrets are redacted).';
export const downloadNote = (name: string): string => `download denied: ${name}`;
