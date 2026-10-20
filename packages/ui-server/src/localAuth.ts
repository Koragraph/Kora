// @effect-diagnostics nodeBuiltinImport:off -- plain Node APIs: the request guard runs on the raw node:http server, ahead of Effect.
// @effect-diagnostics globalDate:off -- ticket expiry is plain wall-clock bookkeeping outside any Effect fiber.
/**
 * Who may talk to the UI API on 127.0.0.1:<port>.
 *
 * Loopback is NOT a trust boundary: any web page the user opens can dial `ws://127.0.0.1:<port>/ws` (browsers never
 * preflight a WebSocket upgrade) and send simple cross-origin requests, and a DNS-rebound hostname can reach the
 * port as if it were same-origin. The `/ws` RPC drives coding agents (bypass-permissions included), so an open socket
 * is remote code execution. Every request therefore passes three checks, on the raw node server, before any route:
 *
 * 1. Host is `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>` — defeats DNS rebinding.
 * 2. Origin, when sent, is the desktop renderer (`kora://app`, `kora-dev://app`) or listed in
 *    `KORA_UI_ALLOWED_ORIGINS` — defeats drive-by pages. Non-browser clients send no Origin.
 * 3. A per-home secret (`<kora home>/ui-token`, 0600): `Authorization: Bearer <secret>` or `x-kora-ui-token` on
 *    `/api/*`, a single-use ticket (minted by `POST /api/auth/websocket-ticket`) or the header on `/ws`. The Electron
 *    main process reads the file and exchanges it at `/oauth/token`, then hands the renderer the resulting bearer
 *    over IPC; the Vite dev proxy injects the header. Readiness probes (`/`, `/.well-known/kora/host`), `/oauth/token` (it checks the
 *    secret itself), the identity challenge (`/.well-known/kora/identity`) and CORS preflights need only checks 1–2.
 *    The unix socket is unaffected.
 *
 * Identity before credential: loopback ports are not per-user, so while the daemon is down another local user can
 * bind its port. The desktop therefore never sends the secret until whatever answers proves it holds it:
 * `GET /.well-known/kora/identity?nonce=<n>` returns HMAC-SHA256(secret, "kora-ui-identity/v1\n<port>\n<n>")
 * (`identityProof`; client side `packages/client-runtime/src/auth/identity.ts`).
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeFs from "node:fs";
import { LIVE_PATH_RE } from "./handlers/blobs-browser.ts";
import { koraHome } from "./paths.ts";

const UI_TOKEN_FILE = "ui-token";
export const UI_TOKEN_HEADER = "x-kora-ui-token";
/** The packaged renderer (`kora://app`) and the dev desktop renderer (`kora-dev://app`). */
export const APP_ORIGINS: ReadonlyArray<string> = ["kora://app", "kora-dev://app"];

const TICKET_TTL_MS = 60_000;
const IDENTITY_CONTEXT = "kora-ui-identity/v1";
/** A client nonce: base64url, at least 128 bits, bounded. */
const IDENTITY_NONCE = /^[A-Za-z0-9_-]{22,128}$/;
const MAX_TICKETS = 256;

/** `KORA_HOME` or `~/.kora` (paths.ts). */
export const defaultKoraHome = koraHome;

/**
 * The daemon's UI secret: reuse `<home>/ui-token` when it holds one, else create it (0600, atomic). Stable across
 * daemon restarts so a running desktop's cached session survives them; delete the file to rotate it.
 */
export function ensureUiToken(home: string): string {
  NodeFs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = NodePath.join(home, UI_TOKEN_FILE);
  try {
    const existing = NodeFs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) {
      if ((NodeFs.statSync(file).mode & 0o077) !== 0) NodeFs.chmodSync(file, 0o600);
      return existing;
    }
  } catch {
    /* missing or unreadable: mint a new one */
  }
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = NodeFs.openSync(tmp, "w", 0o600);
  try {
    NodeFs.writeSync(fd, `${token}\n`);
  } finally {
    NodeFs.closeSync(fd);
  }
  NodeFs.chmodSync(tmp, 0o600);
  NodeFs.renameSync(tmp, file);
  return token;
}

export interface RequestLike {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
}

export type Verdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 | 403; readonly reason: string };

export interface LocalAuth {
  /** Constant-time comparison against the secret. */
  readonly tokenMatches: (candidate: string | null | undefined) => boolean;
  /** A single-use `/ws` ticket, valid for a minute. */
  readonly issueTicket: () => { ticket: string; expiresAt: string };
  /** The access check for one request (both `request` and `upgrade`); consumes a `/ws` ticket it accepts. */
  readonly check: (req: RequestLike) => Verdict;
  /** Proof that this daemon holds the secret, for a client-chosen nonce (null for a malformed nonce). */
  readonly identityProof: (nonce: string | null | undefined) => string | null;
}

function header(req: RequestLike, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : (v as string | undefined);
}

function digest(s: string): Buffer {
  return NodeCrypto.createHash("sha256").update(s).digest();
}

/** The credential a request presents in a header: `Authorization: Bearer <t>` or `x-kora-ui-token: <t>`. */
function presentedToken(req: RequestLike): string | undefined {
  const direct = header(req, UI_TOKEN_HEADER);
  if (direct) return direct.trim();
  const auth = header(req, "authorization");
  const m = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
  return m?.[1]?.trim();
}

/** Origins beyond the app's own, from `KORA_UI_ALLOWED_ORIGINS` (comma-separated). Empty by default. */
export function envAllowedOrigins(): ReadonlyArray<string> {
  return (process.env.KORA_UI_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Paths any allowed Host/Origin may reach without the secret (readiness probes; `/oauth/token` checks it itself). */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/.well-known/kora/host",
  "/.well-known/kora/identity",
  "/oauth/token",
]);

/** The request target's path exactly as sent (no decoding, no dot-segment folding), the query cut off. A `#` is
 *  never sent by a browser, so it stays in the path (and such a path is not credential-free). */
function rawPathOf(target: string): string {
  const cut = target.indexOf("?");
  return cut === -1 ? target : target.slice(0, cut);
}

export function makeLocalAuth(opts: {
  readonly token: string;
  readonly port: number;
  readonly extraOrigins?: ReadonlyArray<string>;
  readonly now?: () => number;
}): LocalAuth {
  const now = opts.now ?? Date.now;
  const tokenDigest = digest(opts.token);
  const origins = new Set([...APP_ORIGINS, ...(opts.extraOrigins ?? [])]);
  const hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`]);
  const tickets = new Map<string, number>(); // ticket -> expiry (ms)

  const tokenMatches = (candidate: string | null | undefined): boolean =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    NodeCrypto.timingSafeEqual(digest(candidate), tokenDigest);

  const issueTicket = () => {
    const t = now();
    for (const [k, exp] of tickets) if (exp <= t) tickets.delete(k);
    while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value as string);
    const ticket = NodeCrypto.randomBytes(24).toString("base64url");
    const exp = t + TICKET_TTL_MS;
    tickets.set(ticket, exp);
    return { ticket, expiresAt: new Date(exp).toISOString() };
  };

  const consumeTicket = (ticket: string | null): boolean => {
    if (!ticket) return false;
    const exp = tickets.get(ticket);
    if (exp === undefined) return false;
    tickets.delete(ticket);
    return exp > now();
  };

  const check = (req: RequestLike): Verdict => {
    const host = header(req, "host")?.toLowerCase();
    if (!host || !hosts.has(host)) return { ok: false, status: 403, reason: "host not allowed" };
    const origin = header(req, "origin");
    if (origin !== undefined && !origins.has(origin))
      return { ok: false, status: 403, reason: "origin not allowed" };
    // A CORS preflight never carries `Upgrade`; an OPTIONS upgrade is not a preflight and gets no pass.
    if ((req.method ?? "GET").toUpperCase() === "OPTIONS" && header(req, "upgrade") === undefined)
      return { ok: true };
    const target = req.url ?? "/";
    let url: URL;
    try {
      url = new URL(target, "http://localhost");
    } catch {
      return { ok: false, status: 403, reason: "malformed request target" };
    }
    // The credential-free paths are matched on the RAW request path, never on the WHATWG-normalized one: the router
    // matches the raw path, and `new URL` folds `..`, `%2e%2e` and `\` — `/api/attachments/%2e%2e/%2e%2e` normalizes to
    // `/` (credential-free) while the router still dispatches it to `/api/attachments/:threadId/:attachmentId`.
    const rawPath = rawPathOf(target);
    if (PUBLIC_PATHS.has(rawPath)) return { ok: true };
    if (tokenMatches(presentedToken(req))) return { ok: true };
    // browsers cannot set headers on a WebSocket: /ws and the blob browser's live view take a single-use ticket
    if (
      (rawPath === "/ws" || LIVE_PATH_RE.test(rawPath)) &&
      consumeTicket(url.searchParams.get("wsTicket"))
    )
      return { ok: true };
    return { ok: false, status: 401, reason: "missing or invalid kora UI credential" };
  };

  const identityProof = (nonce: string | null | undefined): string | null => {
    if (typeof nonce !== "string" || !IDENTITY_NONCE.test(nonce)) return null;
    return NodeCrypto.createHmac("sha256", opts.token)
      .update(`${IDENTITY_CONTEXT}\n${opts.port}\n${nonce}`)
      .digest("base64url");
  };

  return { tokenMatches, issueTicket, check, identityProof };
}

let current: LocalAuth | null = null;
/** The serving listener's auth, for the routes that mint sessions and tickets (`http.ts`). */
export function setLocalAuth(auth: LocalAuth | null): void {
  current = auth;
}
export function localAuth(): LocalAuth {
  if (current === null) throw new Error("kora UI auth is not initialised");
  return current;
}
