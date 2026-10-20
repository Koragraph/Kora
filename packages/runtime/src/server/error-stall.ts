// A worker whose agent stopped on a TRANSIENT API/network error ("API Error: The response stopped arriving") sits at
// an idle prompt with no report: to the lead it looked done-but-silent and it waited forever. Detect it from the
// transcript (authoritative: Claude Code writes the error as a synthetic assistant record with isApiErrorMessage) or,
// without one, from the last lines above the input box; flag the worker `error-stalled`; send "continue" once per
// stall, at most ERROR_STALL_MAX_RETRIES times per worker. Limits, auth, bad model etc. are NOT transient — those stay
// a "STOPPED" problem for the lead (a retry would fail the same way).
import fs from 'node:fs';

export const ERROR_STALL_MAX_RETRIES = 6;
export const ERROR_STALL_CONTINUE = 'continue';

/** Back-off before each automatic retry of a turn that failed on a transient error (GUI workers and chat threads alike). */
export const DRIVER_RETRY_DELAYS_MS = [4_000, 15_000, 45_000, 90_000, 180_000, 300_000];
/** Back-off for a short rate limit (429 / per-minute quota): long enough for the provider's window to pass. */
export const DRIVER_RATE_LIMIT_DELAYS_MS = [30_000, 60_000, 120_000, 180_000, 300_000, 300_000];

/** Messages Claude Code (and other CLIs) print for errors a plain retry usually gets past. Every one seen live. */
const TRANSIENT = /response stopped arriving|stalled mid-stream|(?:connection|server error) (?:lost|closed|dropped)? ?mid-response|connection (?:to the api was )?(?:lost|closed|dropped|reset|refused)|can'?t reach the api|unable to connect to api \((?:ENOTFOUND|ConnectionRefused|ECONNREFUSED)\)|no response from api|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network error|request timed out|\b5\d\d\b[^\n]{0,40}(?:server|overloaded|error|unavailable|gateway)|\boverloaded\b|internal server error|service unavailable|bad gateway|network (?:issue|problem|connection)|stream (?:was |has )?(?:interrupted|disconnected|closed|ended)|stopped responding|did not start within|TLS handshake|unexpected EOF|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ENETRESET|connect(?:ion)? timed? ?out|timed out|temporarily unavailable|high demand|error sending request|reconnecting|incomplete (?:chunked|message)|exited \(code (?:\d+|null)\) without an answer/i;
/** Not a retry's business: the same call fails again (or must not be repeated). A 4xx counts only as a status code
 *  ("API Error: 401", "status 400", "HTTP 403"), never as any number in the text (a "took 450 ms" made a 500 permanent). */
const PERMANENT = /usage limit|rate[ -]?limit|quota|insufficient (?:credit|balance)|billing|unauthori[sz]ed|not logged in|\blog ?in\b|invalid api key|authentication|oauth|certificate|does not support this model|model_not_found|not have access|invalid_request|(?:api error|status|http|code|error)[: ]+4\d\d\b|^4\d\d\b/i;
/** A plan / account limit: hours away, never worth a retry (Claude "usage limit reached", "You've hit your limit ·
 *  resets 3pm"; Codex "You've hit your usage limit"; credits and billing; OpenAI's 429 insufficient_quota; a per-day quota). */
const ACCOUNT_LIMIT = /usage limit|hit your (?:usage )?limit|limit (?:reached|will reset)[^\n]{0,40}reset|resets? (?:at|in) \d|insufficient (?:credit|balance)|billing|out of credits|monthly|daily (?:limit|quota)|insufficient_quota|exceeded your (?:current )?quota|\bper[ -]?day\b|requests?per[ -]?day/i;
/** A short rate limit (requests or tokens per minute) the provider lifts within seconds to minutes. */
const RATE_LIMIT = /rate[ -_]?limit|too many requests|\b429\b|per[ -]minute|resource[ _]exhausted|try again in \d+ ?(?:s|sec|seconds|ms|m|min)/i;
/** Transcript `error` kinds a retry can fix. */
const TRANSIENT_KINDS = new Set(['server_error', 'unknown', 'overloaded_error', 'api_error', 'timeout']);

/** The error text when `line` is a transient API/network failure, else null. Pure. */
export function transientErrorText(line: string): string | null {
  const t = line.replace(/\s+/g, ' ').trim();
  if (!t || !TRANSIENT.test(t) || PERMANENT.test(t)) return null;
  return t.replace(/^[⎿⏺●•\s]+/, '').slice(0, 200);
}

export type RetryableError = { text: string; kind: 'transient' | 'rate-limit' };

/**
 * What a GUI worker (DriverPane) may retry on its own after a back-off: every transient error, plus a SHORT rate limit
 * (429 / per-minute quota) — not a plan or account limit, not auth, not a bad request. The terminal-pane path keeps
 * `transientErrorText`, which types "continue" at once and so must not touch rate limits. Pure.
 */
export function retryableErrorText(line: string): RetryableError | null {
  const transient = transientErrorText(line);
  if (transient) return { text: transient, kind: 'transient' };
  const t = line.replace(/\s+/g, ' ').trim();
  if (!t || !RATE_LIMIT.test(t) || ACCOUNT_LIMIT.test(t)) return null;
  // Rate-limited AND told to log in / bad key / no access: still not ours to retry.
  if (/unauthori[sz]ed|not logged in|\blog ?in\b|invalid api key|authentication|not have access|model_not_found/i.test(t)) return null;
  return { text: t.replace(/^[⎿⏺●•\s]+/, '').slice(0, 200), kind: 'rate-limit' };
}

/**
 * The transient error the agent stopped on, read from the screen: only the last few content lines above the input
 * box count (an error that scrolled above later output was already got past). Pure.
 */
export function errorStallFromScreen(screen: string, window = 4): string | null {
  const rows = screen.split('\n');
  // Drop the input box and everything below it: find the prompt line (`>` / `❯`, bare or inside `│ … │`), then the
  // rule / box top just above it (Claude: `╭───` or `────`).
  let end = rows.length;
  let prompt = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (/^\s*(?:│\s*)?[>❯](?:\s|$)/.test(rows[i])) { prompt = i; break; }
  if (prompt >= 0) { end = prompt; while (end > 0 && /^\s*[╭─━]{6,}/.test(rows[end - 1])) end--; }
  const content = rows.slice(0, end).filter((l) => /\S/.test(l) && !/^\s*[╰╭│─]/.test(l));
  for (const l of content.slice(-window).reverse()) { const hit = transientErrorText(l); if (hit) return hit; }
  return null;
}

export type TranscriptVerdict = { error: string } | { ok: true } | null;
/**
 * What the transcript's LAST main-chain assistant record says: a transient API error, a normal reply (ok — the
 * screen's verdict is overridden), or null when there is no transcript / nothing to go by. Reads only the tail.
 */
export function errorStallFromTranscript(file: string | null | undefined, tailBytes = 64 * 1024): TranscriptVerdict {
  if (!file) return null;
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - tailBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim(); if (!l.startsWith('{')) continue;
    let r: any; try { r = JSON.parse(l); } catch { continue; }
    if (r.isSidechain) continue;
    if (r.type === 'user' && !isToolResult(r)) return { ok: true }; // a new human/lead prompt after it: not stalled on that error
    if (r.type !== 'assistant') continue;
    if (!r.isApiErrorMessage) return { ok: true };
    const msg = Array.isArray(r.message?.content) ? r.message.content.map((c: any) => (c?.type === 'text' ? c.text : '')).join(' ') : String(r.message?.content ?? '');
    const kind = typeof r.error === 'string' ? r.error : '';
    const hit = transientErrorText(msg);
    if (hit && (!kind || TRANSIENT_KINDS.has(kind))) return { error: hit };
    if (!hit && TRANSIENT_KINDS.has(kind) && !PERMANENT.test(msg)) return { error: msg.replace(/\s+/g, ' ').trim().slice(0, 200) || kind };
    return { ok: true }; // a permanent API error: not ours to retry (the lead sees it as STOPPED)
  }
  return null;
}
function isToolResult(r: any): boolean {
  const c = r.message?.content;
  return Array.isArray(c) && c.length > 0 && c.every((x: any) => x?.type === 'tool_result');
}

/** Transcript first (authoritative either way), the screen when there is no transcript. */
export function detectErrorStall(screen: string, transcript: TranscriptVerdict): string | null {
  if (transcript && 'ok' in transcript) return null;
  if (transcript && 'error' in transcript) return transcript.error;
  return errorStallFromScreen(screen);
}

export interface ErrorStall { line: string; at: number; retries: number; retrying: boolean }

/**
 * The next error-stall state when a worker goes idle, and whether to send "continue". One retry per stall episode
 * (an idle that follows our own "continue" with the error still there is the same worker failing again, and counts
 * against the cap); at the cap the flag stays up for the lead with no retry. A clean idle clears the flag but the
 * worker's retry count is kept (`retriesUsed`) so a flapping network cannot loop it forever. Pure.
 */
export function nextErrorStall(prev: ErrorStall | null, retriesUsed: number, detected: string | null, now: number, cap = ERROR_STALL_MAX_RETRIES): { stall: ErrorStall | null; retry: boolean } {
  if (!detected) return { stall: null, retry: false };
  const retry = retriesUsed < cap;
  return { stall: { line: detected, at: prev?.at ?? now, retries: retriesUsed + (retry ? 1 : 0), retrying: retry }, retry };
}
