import * as NodeTimersPromises from "node:timers/promises";
import * as Electron from "electron";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import Mime from "@effect/platform-node/Mime";

import { HTML_PREVIEW_SCHEME, htmlPreviewStore, serveHtmlPreview } from "./HtmlPreviewProtocol.ts";

/** The renderer's own host inside the app scheme: `<scheme>://app/...`. */
const APP_HOST = "app";

export const getShellScheme = (isDevelopment: boolean): string =>
  isDevelopment ? "kora-dev" : "kora";

export const getShellUrl = (isDevelopment: boolean): string =>
  `${getShellScheme(isDevelopment)}://${APP_HOST}/`;

export class NativeProtocolRegistrationError extends Schema.TaggedError<NativeProtocolRegistrationError>()(
  "NativeProtocolRegistrationError",
  { scheme: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to register Electron protocol scheme "${this.scheme}".`;
  }
}

export class NativeProtocolUnregistrationError extends Schema.TaggedError<NativeProtocolUnregistrationError>()(
  "NativeProtocolUnregistrationError",
  { scheme: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to unregister Electron protocol scheme "${this.scheme}".`;
  }
}

/** Serve the client from a directory (packaged) or forward everything to a dev server. */
export type ShellProtocolRegistrationInput = { readonly scheme: string } & (
  | { readonly targetOrigin: URL }
  | { readonly assetDirectory: string }
);

export class NativeProtocol extends Context.Service<
  NativeProtocol,
  {
    readonly registerDesktopProtocol: (
      registration: ShellProtocolRegistrationInput,
    ) => Effect.Effect<void, NativeProtocolRegistrationError, Scope.Scope>;
  }
>()("@kora/desktop/native/NativeProtocol") {}

export function makeShellContentSecurityPolicy(
  registration: ShellProtocolRegistrationInput,
): string {
  const own = `${registration.scheme}:`;
  // Only the dev server needs inline scripts (Vite's module preamble); the shipped client has none.
  const scripts =
    "targetOrigin" in registration
      ? "'self' 'unsafe-inline' 'wasm-unsafe-eval'"
      : "'self' 'wasm-unsafe-eval'";
  return [
    "default-src 'self'",
    `script-src ${scripts}`,
    // The daemon (and the dev server) on loopback only (2026-10-15 audit desktop #4): the renderer holds a bearer that
    // drives agents, so a markdown/tool-output XSS must not be able to send it, or anything else, to another host.
    "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* http://[::1]:* ws://[::1]:*",
    `img-src 'self' ${own} blob: data: http: https:`,
    `media-src 'self' ${own} blob: http: https:`,
    "style-src 'self' 'unsafe-inline'",
    `font-src 'self' ${own} data:`,
    "worker-src 'self' blob:",
    `frame-src 'self' blob: http: https: ${HTML_PREVIEW_SCHEME}:`,
    "form-action 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/** Must run before the app is ready; privileges registered later are ignored. */
export const layerSchemePrivileges = Layer.effectDiscard(
  Effect.sync(() => {
    const full = {
      stream: true,
      corsEnabled: true,
      supportFetchAPI: true,
      secure: true,
      standard: true,
    };
    Electron.protocol.registerSchemesAsPrivileged([
      { scheme: "kora", privileges: full },
      { scheme: "kora-dev", privileges: full },
      // A secure origin of its own, but no fetch/CORS and no policy bypass.
      { scheme: HTML_PREVIEW_SCHEME, privileges: { standard: true, secure: true } },
    ]);
  }).pipe(Effect.withSpan("shell.electron.protocol.registerSchemePrivileges")),
);

const withPolicy = (resp: Response, csp: string): Response => {
  const headers = new Headers(resp.headers);
  headers.set("Content-Security-Policy", csp);
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
};

const escapeHtml = (str: string) =>
  str.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const missingClientPage = (baseDir: string) =>
  new Response(
    `<body style="font:14px system-ui;color:#ddd;background:#111;padding:2em">` +
      `<h3>Kora could not load its interface</h3>` +
      `<p>The web client is missing at <code>${escapeHtml(baseDir)}</code>.</p></body>`,
    { status: 500, headers: { "content-type": "text/html; charset=utf-8" } },
  );

// Headers that must not be forwarded to the dev server: they describe the custom-scheme page, not the target.
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "origin",
  "referer",
  "connection",
  "content-length",
  "accept-encoding",
  "upgrade-insecure-requests",
]);
const RETRY_DELAYS_MS = [0, 50, 150] as const;

async function forwardToDevServer(req: Request, originUrl: URL): Promise<Response> {
  const source = new URL(req.url);
  const dest = new URL(`${source.pathname}${source.search}`, originUrl);
  const headers = new Headers();
  for (const [name, value] of req.headers) {
    if (!DROPPED_REQUEST_HEADERS.has(name) && !name.startsWith("sec-fetch-"))
      headers.set(name, value);
  }
  const bodyless = req.method === "GET" || req.method === "HEAD";
  if (!bodyless) {
    return Electron.net.fetch(dest.href, {
      method: req.method,
      headers,
      body: req.body,
      duplex: "half",
    } as RequestInit);
  }
  let lastError: unknown;
  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) await NodeTimersPromises.setTimeout(delay);
    try {
      return await Electron.net.fetch(dest.href, { method: req.method, headers });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const make = Effect.gen(function* () {
  const fsys = yield* FileSystem.FileSystem;
  const loc = yield* Path.Path;
  const services = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(services);
  let registered = false;

  const readableFile = (cand: string) =>
    fsys.stat(cand).pipe(
      Effect.map((meta) => meta.type === "File"),
      Effect.orElseSucceed(() => false),
    );

  const serveAsset = async (req: Request, baseDir: string, csp: string): Promise<Response> => {
    const address = new URL(req.url);
    if (address.hostname !== APP_HOST) return new Response(null, { status: 404 });
    const isHead = req.method === "HEAD";
    if (req.method !== "GET" && !isHead) return new Response(null, { status: 405 });

    let requested: string;
    try {
      requested = decodeURIComponent(address.pathname);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (requested.includes("\0")) return new Response(null, { status: 400 });

    const resolvedRoot = loc.resolve(baseDir);
    const cand = loc.resolve(resolvedRoot, requested.replace(/^\/+/, ""));
    const inside = loc.relative(resolvedRoot, cand);
    if (inside.startsWith("..") || loc.isAbsolute(inside))
      return new Response(null, { status: 404 });

    const reply = (fileRef: string, buf: Uint8Array) =>
      withPolicy(
        new Response(isHead ? null : (buf as BodyInit), {
          status: 200,
          headers: {
            "content-type": Mime.getType(fileRef) ?? "application/octet-stream",
            "cache-control": "no-store",
          },
        }),
        csp,
      );

    if (await runPromise(readableFile(cand))) {
      const buf = await runPromise(fsys.readFile(cand).pipe(Effect.option));
      if (buf._tag === "Some") return reply(cand, buf.value);
    }

    // A miss that looks like an asset (has an extension, page not asking for HTML) is a plain 404.
    const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
    if (loc.extname(requested) !== "" && !wantsHtml) return new Response(null, { status: 404 });

    const pos = loc.join(resolvedRoot, "index.html");
    const page = await runPromise(fsys.readFile(pos).pipe(Effect.option));
    if (page._tag === "None") {
      await runPromise(
        Effect.logError(`${address.protocol}// cannot serve the web client: ${pos} is missing`),
      );
      return withPolicy(missingClientPage(resolvedRoot), csp);
    }
    return reply(pos, page.value);
  };

  const serveProxy = async (req: Request, originUrl: URL, csp: string): Promise<Response> => {
    if (new URL(req.url).hostname !== APP_HOST) return new Response(null, { status: 404 });
    return withPolicy(await forwardToDevServer(req, originUrl), csp);
  };

  const registerDesktopProtocol = (registration: ShellProtocolRegistrationInput) =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        if (registered) return Effect.void;
        return Effect.try({
          try: () => {
            const csp = makeShellContentSecurityPolicy(registration);
            Electron.protocol.handle(HTML_PREVIEW_SCHEME, (req) =>
              serveHtmlPreview(req, htmlPreviewStore()),
            );
            Electron.protocol.handle(registration.scheme, (req) =>
              "targetOrigin" in registration
                ? serveProxy(req, registration.targetOrigin, csp)
                : serveAsset(req, registration.assetDirectory, csp),
            );
            registered = true;
          },
          catch: (reason) =>
            new NativeProtocolRegistrationError({ scheme: registration.scheme, cause: reason }),
        });
      }),
      () =>
        Effect.suspend(() => {
          registered = false;
          let fault: unknown;
          for (const scheme of [registration.scheme, HTML_PREVIEW_SCHEME]) {
            try {
              Electron.protocol.unhandle(scheme);
            } catch (reason) {
              fault ??= reason;
            }
          }
          return fault === undefined
            ? Effect.void
            : Effect.die(
                new NativeProtocolUnregistrationError({
                  scheme: registration.scheme,
                  cause: fault,
                }),
              );
        }),
    ).pipe(Effect.asVoid);

  return NativeProtocol.of({ registerDesktopProtocol });
});

export const layer = Layer.effect(NativeProtocol, make);
