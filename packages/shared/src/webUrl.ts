/**
 * Pure URL helpers shared between the preview server, desktop main process,
 * and web renderer. Centralising these guarantees the four call sites agree
 * on what counts as "loopback" and how to normalise a free-form URL string.
 */

import * as Schema from "effect/Schema";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

/** Internal — used by `lsof` parsing where the host string is wire-formatted. */

const LOOPBACK_PREFIX_PATTERN = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i;

export function isLoopbackHost(host: string): boolean {
  return host === "[::1]" || LOOPBACK_HOSTS.has(host);
}

export class WebUrlNormalizationError extends Schema.TaggedError<WebUrlNormalizationError>()(
  "WebUrlNormalizationError",
  {
    cause: Schema.optional(Schema.Defect()),
    protocol: Schema.optional(Schema.String),
    reason: Schema.Literals(["empty", "parse", "unsupported-protocol"]),
    inputLength: Schema.Number,
  },
) {
  override get message(): string {
    const suffix = this.protocol === undefined ? "" : ": " + this.protocol;
    return (
      "Invalid preview URL (" + this.reason + suffix + "; input length " + this.inputLength + ")."
    );
  }
}

function webUrlProtocol(rawUrl: string): string | undefined {
  return /^([A-Za-z][A-Za-z\d+.-]*):/.exec(rawUrl)?.[1]?.toLowerCase().concat(":");
}

function tryParseUrl(candidate: string, onFailure: (cause: unknown) => Error): URL {
  try {
    return new URL(candidate);
  } catch (cause) {
    throw onFailure(cause);
  }
}

/**
 * Normalise a free-form URL string into a fully-qualified `http(s)://` URL.
 *
 * - Bare loopback hosts (`localhost`, `localhost:5173`) become `http://...`.
 * - Bare public hosts (`example.com`) become `https://...`.
 * - Already-qualified URLs are validated and returned as `URL.href`.
 *
 * Throws `WebUrlNormalizationError` for empty, unparseable, or
 * unsupported-protocol inputs.
 */
export function normalizeWebUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw new WebUrlNormalizationError({ inputLength: rawUrl.length, reason: "empty" });
  }
  const scheme = LOOPBACK_PREFIX_PATTERN.test(trimmed) ? "http" : "https";
  const candidate = trimmed.includes("://") ? trimmed : scheme + "://" + trimmed;
  const parsed = tryParseUrl(
    candidate,
    (cause) =>
      new WebUrlNormalizationError({
        cause,
        protocol: webUrlProtocol(candidate),
        reason: "parse",
        inputLength: rawUrl.length,
      }),
  );
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebUrlNormalizationError({
      protocol: parsed.protocol,
      reason: "unsupported-protocol",
      inputLength: rawUrl.length,
    });
  }
  return parsed.href;
}
