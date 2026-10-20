import { terminalAppName } from "./utils";

/**
 * Calm display copy for agent errors a Kora user cannot act on as written. The Claude SDK
 * reports a signed-out CLI as "Not logged in · Please run /login", but /login is a Claude
 * Code slash command: a Kora user fixes it from a terminal. Callers keep the raw text for
 * a details/tooltip view.
 */
export const CLAUDE_NOT_SIGNED_IN_COPY = `Claude isn't signed in. Click Sign in to Claude (it opens your browser; no install needed), then send again. Or in ${terminalAppName()}, run \`claude auth login\`.`;

const CLAUDE_NOT_LOGGED_IN = /\bnot logged in\b[\s\S]*\/login\b|\bplease run \/login\b/i;

/** A signed-out `codex exec` ends its turn with the API's raw 401 ("Missing bearer or basic authentication"). */
export const CODEX_NOT_SIGNED_IN_COPY =
  "Codex isn't signed in. In Terminal, run `codex login`, then send again.";
const CODEX_UNAUTHORIZED =
  /\b401 Unauthorized\b[\s\S]*\b(?:bearer|basic authentication|api\.openai\.com)/i;

/** Gemini CLI with a missing/invalid key replies with the API's raw 400 JSON (`API_KEY_INVALID`). */
export const GEMINI_NOT_SIGNED_IN_COPY =
  "Gemini CLI isn't signed in (its API key is missing or invalid). In Terminal, run `gemini` once and sign in, then send again.";
const GEMINI_KEY_INVALID = /\bAPI_KEY_INVALID\b|API key not valid\b/i;

/**
 * Claude Code gives up on a request it could not deliver (no network, a proxy/firewall, DNS) after ~3 minutes of
 * retries and replies with its own "API Error: Connection …" line. Anchored on that prefix so an ordinary reply that
 * merely mentions ECONNREFUSED is never rewritten.
 */
export const CLAUDE_UNREACHABLE_COPY =
  "Kora couldn't reach Claude — there was no connection to Anthropic's servers. Check your internet connection (or a VPN or proxy that blocks it), then press Retry.";
const CLAUDE_UNREACHABLE =
  /^API Error: (?:Connection (?:error|refused)|Request timed out|Unable to connect|getaddrinfo|fetch failed)|^API Error: .{0,160}\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)\b/;

/** The calm copy for `raw`, or null when `raw` needs no translation. */
export function friendlyAgentErrorCopy(unparsed: string | null | undefined): string | null {
  if (!unparsed) return null;
  if (CLAUDE_NOT_LOGGED_IN.test(unparsed)) return CLAUDE_NOT_SIGNED_IN_COPY;
  if (CODEX_UNAUTHORIZED.test(unparsed)) return CODEX_NOT_SIGNED_IN_COPY;
  if (GEMINI_KEY_INVALID.test(unparsed)) return GEMINI_NOT_SIGNED_IN_COPY;
  if (unparsed.length < 400 && CLAUDE_UNREACHABLE.test(unparsed.trim()))
    return CLAUDE_UNREACHABLE_COPY;
  return null;
}

/** Two error texts that the user would read as the same message (same raw text, or the same calm copy). */
function sameAgentError(left: string, right: string): boolean {
  const leftText = left.trim();
  const rightText = right.trim();
  if (!leftText || !rightText) return false;
  if (leftText === rightText) return true;
  const leftCopy = friendlyAgentErrorCopy(leftText);
  return leftCopy !== null && leftCopy === friendlyAgentErrorCopy(rightText);
}

/**
 * The id of the reply that already shows the thread's current error inline — Claude Code answers a signed-out,
 * offline or rate-limited turn with an assistant message carrying the same text as the session error — or null.
 * Only the latest reply counts (after the last user message): an older one is history, not the current problem.
 * The thread shows that error ONCE: inline, with the actions, instead of a banner repeating it above.
 */
export function inlineAgentErrorMessageId(
  messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly streaming?: boolean;
    readonly id: string;
  }>,
  err: string | null | undefined,
): string | null {
  if (!err || !err.trim()) return null;
  for (let idx = messages.length - 1; idx >= 0; idx--) {
    const message = messages[idx]!;
    if (message.role === "user") return null;
    if (message.role !== "assistant") continue;
    if (message.streaming) return null;
    return sameAgentError(message.text, err) ? message.id : null;
  }
  return null;
}
