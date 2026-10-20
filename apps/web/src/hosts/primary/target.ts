import { PRIMARY_LOCAL_HOST_ID } from "@kora/contracts";
import * as Schema from "effect/Schema";

export interface PrimaryHostTarget {
  readonly source: "configured" | "window-origin" | "desktop-managed";
  readonly target: {
    readonly wsBaseUrl: string;
    readonly httpBaseUrl: string;
  };
}

type Source = PrimaryHostTarget["source"];

export class PrimaryHostUrlInvalidError extends Schema.TaggedError<PrimaryHostUrlInvalidError>()(
  "PrimaryHostUrlInvalidError",
  {
    cause: Schema.Defect(),
    urlKind: Schema.Literals([
      "window-location-url",
      "development-server-url",
      "websocket-base-url",
      "http-base-url",
    ]),
    source: Schema.Literals(["configured", "window-origin", "desktop-managed"]),
  },
) {
  override get message() {
    return `Could not parse ${this.urlKind} for the ${this.source} primary environment target.`;
  }
}

export class PrimaryHostProtocolUnsupportedError extends Schema.TaggedError<PrimaryHostProtocolUnsupportedError>()(
  "PrimaryHostProtocolUnsupportedError",
  {
    source: Schema.Literals(["configured", "window-origin", "desktop-managed"]),
    protocol: Schema.String,
  },
) {
  override get message() {
    return `The ${this.source} primary environment target uses unsupported protocol ${this.protocol}.`;
  }
}

export class ShellHostBootstrapIncompleteError extends Schema.TaggedError<ShellHostBootstrapIncompleteError>()(
  "ShellHostBootstrapIncompleteError",
  { hasHttpBaseUrl: Schema.Boolean, hasWsBaseUrl: Schema.Boolean },
) {
  override get message() {
    const absent: string[] = [];
    if (!this.hasHttpBaseUrl) absent.push("httpBaseUrl");
    if (!this.hasWsBaseUrl) absent.push("wsBaseUrl");
    const missing = absent.join(" and ");
    return `Desktop bootstrap is missing ${missing} for the local environment.`;
  }
}

export class PrimaryHostDisabledError extends Schema.TaggedError<PrimaryHostDisabledError>()(
  "PrimaryHostDisabledError",
  {},
) {
  override get message() {
    return "The local environment is disabled.";
  }
}

export const isPrimaryHostUrlInvalidError = Schema.is(PrimaryHostUrlInvalidError);
export const isPrimaryHostProtocolUnsupportedError = Schema.is(PrimaryHostProtocolUnsupportedError);
export const isShellHostBootstrapIncompleteError = Schema.is(ShellHostBootstrapIncompleteError);

const env = (): Record<string, string | undefined> =>
  import.meta.env as unknown as Record<string, string | undefined>;

function normalizeUrl(
  unparsed: string,
  source: Source,
  urlKind: "http-base-url" | "websocket-base-url",
): string {
  try {
    return new URL(unparsed, window.location.origin).toString();
  } catch (reason) {
    throw new PrimaryHostUrlInvalidError({ source, urlKind, cause: reason });
  }
}

function fromDesktopShell(): PrimaryHostTarget | null {
  const bootstrap = window.shellBridge
    ?.getLocalHostBootstraps?.()
    .find((rec) => rec.id === PRIMARY_LOCAL_HOST_ID);
  if (!bootstrap) return null;
  const http = bootstrap.httpBaseUrl;
  const ws = bootstrap.wsBaseUrl;
  if (!http && !ws) return null;
  if (!http || !ws) {
    throw new ShellHostBootstrapIncompleteError({ hasHttpBaseUrl: !!http, hasWsBaseUrl: !!ws });
  }
  return {
    source: "desktop-managed",
    target: {
      httpBaseUrl: normalizeUrl(http, "desktop-managed", "http-base-url"),
      wsBaseUrl: normalizeUrl(ws, "desktop-managed", "websocket-base-url"),
    },
  };
}

function fromConfiguredEnv(): PrimaryHostTarget | null {
  const configuredHttp = env().VITE_HTTP_URL?.trim() ?? "";
  const configuredWs = env().VITE_WS_URL?.trim() ?? "";
  if (!configuredHttp && !configuredWs) return null;

  // Decide the secure scheme from the raw text, case-insensitively, so WSS:// can never
  // be downgraded to plaintext by a case slip.
  const http =
    configuredHttp ||
    configuredWs.replace(
      /^wss?:/i,
      configuredWs.toLowerCase().startsWith("wss:") ? "https:" : "http:",
    );
  const ws =
    configuredWs ||
    configuredHttp.replace(
      /^https?:/i,
      configuredHttp.toLowerCase().startsWith("https:") ? "wss:" : "ws:",
    );
  return {
    source: "configured",
    target: {
      httpBaseUrl: normalizeUrl(http, "configured", "http-base-url"),
      wsBaseUrl: normalizeUrl(ws, "configured", "websocket-base-url"),
    },
  };
}

function fromWindowOrigin(): PrimaryHostTarget {
  let originUrl: URL;
  try {
    originUrl = new URL(window.location.origin);
  } catch (reason) {
    throw new PrimaryHostUrlInvalidError({
      source: "window-origin",
      urlKind: "window-location-url",
      cause: reason,
    });
  }
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
    throw new PrimaryHostProtocolUnsupportedError({
      source: "window-origin",
      protocol: originUrl.protocol,
    });
  }
  const ws = new URL(originUrl);
  ws.protocol = originUrl.protocol === "https:" ? "wss:" : "ws:";
  return {
    source: "window-origin",
    target: { httpBaseUrl: originUrl.toString(), wsBaseUrl: ws.toString() },
  };
}

export function readPrimaryHostTarget(): PrimaryHostTarget | null {
  if (typeof window === "undefined") return null;
  return fromDesktopShell() ?? fromConfiguredEnv() ?? fromWindowOrigin();
}

const isLoopback = (hostname: string) =>
  ["127.0.0.1", "::1", "localhost"].includes(hostname.replace(/^\[|\]$/g, "").toLowerCase());

/**
 * In dev the page comes from Vite on one loopback port while the daemon sits on another; going
 * through the page origin lets the dev proxy inject the credential.
 */
function devProxyBase(dest: PrimaryHostTarget): string | null {
  const devServer = env().VITE_DEV_SERVER_URL?.trim();
  if (!devServer || typeof window === "undefined") return null;
  let dev: URL;
  let page: URL;
  let daemon: URL;
  try {
    dev = new URL(devServer);
    page = new URL(window.location.origin);
    daemon = new URL(dest.target.httpBaseUrl);
  } catch (reason) {
    throw new PrimaryHostUrlInvalidError({
      source: dest.source,
      urlKind: "development-server-url",
      cause: reason,
    });
  }
  const servedByDevServer =
    (page.protocol === "http:" || page.protocol === "https:") && page.origin === dev.origin;
  return servedByDevServer &&
    isLoopback(page.hostname) &&
    isLoopback(daemon.hostname) &&
    page.origin !== daemon.origin
    ? page.origin
    : null;
}

export function resolvePrimaryHostHttpUrl(
  pathname: string,
  searchParams?: Record<string, string>,
): string {
  const dest = readPrimaryHostTarget();
  if (!dest) throw new PrimaryHostDisabledError();
  const address = new URL(devProxyBase(dest) ?? dest.target.httpBaseUrl);
  // A query written into the pathname would be percent-encoded (`clear%3FblobId=` -> 404):
  // split it off and merge it with `searchParams` instead.
  const queryAt = pathname.indexOf("?");
  const query = new URLSearchParams(queryAt >= 0 ? pathname.slice(queryAt + 1) : "");
  address.pathname = queryAt >= 0 ? pathname.slice(0, queryAt) : pathname;
  for (const [key, value] of Object.entries(searchParams ?? {})) query.set(key, value);
  const search = query.toString();
  if (search) address.search = search;
  return address.toString();
}
