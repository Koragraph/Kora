/**
 * Permission and download policy for in-app browser tabs (preview `<webview>`
 * guests and the popups they open). Electron-free so it is unit-testable;
 * `WebPartitions.ts` installs it on every browser-tab session.
 *
 * Permissions — deny by default:
 * - every site may write to the clipboard (`clipboard-sanitized-write`, the
 *   permission behind `navigator.clipboard.writeText()`; dev-server overlays
 *   such as Next.js' "Copy" button need it, and it cannot read anything);
 * - the user's OWN dev servers (loopback origins: `localhost`, `*.localhost`,
 *   `127.0.0.0/8`, `[::1]`) additionally keep clipboard read, notifications and
 *   geolocation, so an app being built in Kora can still exercise them;
 * - every other origin gets nothing else, silently. A remote site can no longer
 *   read the clipboard, post macOS notifications in Kora's name, or locate the
 *   user without asking.
 *
 * Downloads — see `decideWebTabDownload`: web-scheme sources only, always a
 * save dialog (pre-filled in ~/Downloads with a sanitized file name), never
 * auto-opened or executed, and rate-limited per tab so a page cannot stack
 * dialogs.
 */

/** Allowed for every web origin in a browser tab. */
const ANY_ORIGIN_PERMISSIONS: ReadonlySet<string> = new Set(["clipboard-sanitized-write"]);

/** Additionally allowed for loopback (local dev server) origins. */
const LOOPBACK_ORIGIN_PERMISSIONS: ReadonlySet<string> = new Set([
  "geolocation",
  "notifications",
  "clipboard-sanitized-write",
  "clipboard-read",
  // Deliberately NOT local-fonts even for loopback: it hands over the user's
  // installed-font fingerprint and font bytes; the app's own font picker runs
  // in the main window session, which this policy does not cover.
]);

function parseOrigin(urlText: string | null | undefined): URL | null {
  if (typeof urlText !== "string" || urlText.length === 0) return null;
  try {
    let address = new URL(urlText);
    if (address.protocol === "blob:") address = new URL(address.pathname);
    if (address.protocol !== "http:" && address.protocol !== "https:") return null;
    if (address.username !== "" || address.password !== "") return null;
    return address;
  } catch {
    return null;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const hostInfo = hostname.toLowerCase().replace(/\.$/, "");
  if (hostInfo === "localhost" || hostInfo.endsWith(".localhost")) return true;
  if (hostInfo === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostInfo);
}

export function decideWebTabPermission(request: {
  readonly permission: string;
  readonly requestingUrl: string | null | undefined;
}): boolean {
  const originUrl = parseOrigin(request.requestingUrl);
  if (!originUrl) return false;
  if (ANY_ORIGIN_PERMISSIONS.has(request.permission)) return true;
  return (
    isLoopbackHostname(originUrl.hostname) && LOOPBACK_ORIGIN_PERMISSIONS.has(request.permission)
  );
}

// ── Downloads ────────────────────────────────────────────────────────────────

const DOWNLOAD_SOURCE_PROTOCOLS = new Set(["http:", "https:", "blob:", "data:"]);
const MAX_FILENAME_LENGTH = 120;
const FALLBACK_FILENAME = "download";

/**
 * A file name safe to pre-fill in the save dialog: last path segment only, no
 * control/reserved characters, no leading dots (hidden files, `..`), bounded
 * length (extension kept).
 */
export function sanitizeDownloadFilename(rawName: string | null | undefined): string {
  const fallbackBase = (rawName ?? "").split(/[/\\]/).pop() ?? "";
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point.
  let label = fallbackBase.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim();
  label = label.replace(/^[.\s]+/, "");
  if (label.length === 0) return FALLBACK_FILENAME;
  if (label.length > MAX_FILENAME_LENGTH) {
    const dot = label.lastIndexOf(".");
    const extension = dot > 0 && label.length - dot <= 16 ? label.slice(dot) : "";
    label = label.slice(0, MAX_FILENAME_LENGTH - extension.length) + extension;
  }
  return label;
}

export type WebTabDownloadDecision =
  | { readonly action: "cancel"; readonly reason: "scheme" | "rate-limit" }
  | {
      readonly action: "prompt";
      readonly fileName: string;
      readonly title: string;
      readonly message: string;
    };

function describeDownloadSource(urlText: string): string {
  try {
    const address = new URL(urlText);
    if (address.protocol === "blob:") return new URL(address.pathname).host || "this page";
    if (address.protocol === "data:") return "this page";
    return address.host;
  } catch {
    return "this page";
  }
}

export function decideWebTabDownload(request: {
  readonly url: string;
  readonly suggestedFileName: string | null | undefined;
  readonly allowedByRateLimit: boolean;
}): WebTabDownloadDecision {
  let protocol: string;
  try {
    protocol = new URL(request.url).protocol;
  } catch {
    return { action: "cancel", reason: "scheme" };
  }
  if (!DOWNLOAD_SOURCE_PROTOCOLS.has(protocol)) return { action: "cancel", reason: "scheme" };
  if (!request.allowedByRateLimit) return { action: "cancel", reason: "rate-limit" };
  const source = describeDownloadSource(request.url);
  return {
    action: "prompt",
    fileName: sanitizeDownloadFilename(request.suggestedFileName),
    title: `Save download from ${source}`,
    message: `A page in the Kora browser (${source}) wants to download a file. Kora never opens downloads.`,
  };
}

/** Sliding-window limiter: at most `limit` downloads per key per `windowMs`. */
export function createDownloadRateLimiter(opts: {
  readonly limit: number;
  readonly windowMs: number;
  readonly now: () => number;
}): (keyName: number) => boolean {
  const history = new Map<number, number[]>();
  return (keyName) => {
    const clock = opts.now();
    const recent = (history.get(keyName) ?? []).filter((when) => clock - when < opts.windowMs);
    if (recent.length >= opts.limit) {
      history.set(keyName, recent);
      return false;
    }
    recent.push(clock);
    history.set(keyName, recent);
    return true;
  };
}
