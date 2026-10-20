// @effect-diagnostics globalConsoleInEffect:off globalConsole:off globalFetch:off nodeBuiltinImport:off -- plain HTTP boundary to the in-process kora runtime.
// The plain-HTTP routes of the UI server (loopback only). Every request has already passed the node-level guard in
// `localAuth.ts` (Host, Origin, UI secret on /api/* and /ws); CORS comes from the router's allow-list in server.ts.
import { AccessTokenKind } from "@kora/contracts";
import { renderRepoReportMarkdown, type RepoReport } from "@kora/shared/repoReport";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse, UrlParams } from "effect/unstable/http";

import { applyHealthToAgents } from "./agentReadinessInfo.ts";
import { blobFileVersionHeaders, resolveBlobFile } from "./blobsFs.ts";
import { blobThumbnail } from "./blobThumbs.ts";
import { daemonConfig, hostDescriptor } from "./config.ts";
import { initGitRepo, isSafeToIndex } from "./graph.ts";
import { graphReader } from "./graphReader.ts";
import {
  browserClearData,
  browserEngineSnapshot,
  browserStartInstall,
} from "./handlers/blobs-browser.ts";
import { jsonSafe } from "./handlers/shared.ts";
import { koraSurfaceOn } from "./koraSurface.ts";
import { host } from "./host.ts";
import { chatEngine } from "./kora-chat.ts";
import { defaultKoraHome, localAuth } from "./localAuth.ts";
import { readRecentProjects } from "./recentProjects.ts";
import { USAGE_AGENTS, usageLimits, type UsageProvider } from "./usageLimits.ts";

// ------------------------------------------------------------------ attachment headers

/** Types a browser may render inline without running anything. Everything else downloads. */
const PASSIVE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "application/pdf",
  "text/plain",
]);

const MIME_SHAPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

const isPassive = (type: string) =>
  PASSIVE_TYPES.has(type) || type.startsWith("video/") || type.startsWith("audio/");

/**
 * Response headers for a user-supplied file. The name and type are untrusted and Node refuses header values with
 * CR/LF or characters above U+00FF, so both are normalised; types that can run script are sandboxed downloads.
 */
export function attachmentHeaders(
  name: string,
  mimeType: string,
): { contentType: string; headers: Record<string, string> } {
  const essence = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  const contentType = MIME_SHAPE.test(essence) ? essence : "application/octet-stream";
  const passive = isPassive(contentType);

  const asciiName = name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "file";
  let encodedName: string;
  try {
    encodedName = encodeURIComponent(name).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    // A lone surrogate cannot be percent-encoded; fall back to the ASCII stand-in.
    encodedName = encodeURIComponent(asciiName);
  }

  const headers: Record<string, string> = {
    "content-disposition": `${passive ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  };
  if (!passive) headers["content-security-policy"] = "sandbox; default-src 'none'";
  return { contentType, headers };
}

// ------------------------------------------------------------------ small helpers

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LEGACY_DESKTOP_CREDENTIAL = "kora-desktop";
const TOKEN_LIFETIME_SECONDS = 31_536_000;
const TOKEN_SCOPE = "chat:read chat:operate terminal:operate review:write access:read access:write";

type Reply = HttpServerResponse.HttpServerResponse;

const reply = (body: unknown, status = 200, headers?: Record<string, string>): Reply =>
  HttpServerResponse.jsonUnsafe(body, { status, ...(headers ? { headers } : {}) });

const notFound = (extra: Record<string, unknown> = {}): Reply =>
  reply({ _tag: "HostResourceNotFoundError", ...extra }, 404);

const query = (request: HttpServerRequest.HttpServerRequest): URLSearchParams =>
  new URL(request.url, "http://localhost").searchParams;

const wantsJson = (request: HttpServerRequest.HttpServerRequest): boolean =>
  (request.headers["content-type"] ?? "").includes("application/json");

/** Plain-JSON POSTs insist on this type so a cross-origin page needs a preflight to reach them. */
const notJson = () => reply({ ok: false, reason: "expected application/json" }, 415);

const readJson = (request: HttpServerRequest.HttpServerRequest) =>
  request.json.pipe(Effect.orElseSucceed(() => null));

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Streams a file with the given headers; an unreadable file answers not-found. */
const sendFile = (filePath: string, contentType: string, headers: Record<string, string>) =>
  HttpServerResponse.file(filePath, { contentType, headers }).pipe(
    Effect.orElseSucceed(() => notFound()),
  );

/** A blob's workspace file under confinement, or the matching not-found / too-large reply. */
function blobFile(blobId: string, relative: string) {
  const profile = SAFE_ID.test(blobId) ? host().blobs?.store.get(blobId) : null;
  if (!profile) return { reply: notFound() } as const;
  const found = resolveBlobFile(profile.workspace, relative);
  if (found.ok) return { file: found } as const;
  return {
    reply: found.status === 413 ? reply({ _tag: "HostPayloadTooLargeError" }, 413) : notFound(),
  } as const;
}

const get = <E, R>(
  path: HttpRouter.PathInput,
  handler: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<Reply, E, R>,
) => HttpRouter.add("GET", path, Effect.flatMap(HttpServerRequest.HttpServerRequest, handler));

const post = <E, R>(
  path: HttpRouter.PathInput,
  handler: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<Reply, E, R>,
) => HttpRouter.add("POST", path, Effect.flatMap(HttpServerRequest.HttpServerRequest, handler));

/** Blob routes answer nothing while Kora is "coming soon" (a token-only POST must not start a 100 MB engine download). */
const whenKoraOn =
  <E, R>(handler: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<Reply, E, R>) =>
  (request: HttpServerRequest.HttpServerRequest) =>
    koraSurfaceOn()
      ? handler(request)
      : Effect.succeed(reply({ ok: false, reason: "Kora is coming soon" }, 404));

// ------------------------------------------------------------------ routes: identity and sign-in

const reachability = get("/", () =>
  Effect.succeed(reply({ status: "ok", hostId: hostDescriptor.hostId })),
);

const descriptor = get("/.well-known/kora/host", () => Effect.succeed(reply(hostDescriptor)));

const identity = get("/.well-known/kora/identity", (request) =>
  Effect.sync(() => {
    const proof = localAuth().identityProof(query(request).get("nonce"));
    if (proof === null) return reply({ error: "nonce must be 22-128 base64url characters" }, 400);
    return reply({ v: 1, proof }, 200, { "cache-control": "no-store" });
  }),
);

const tokenExchange = post("/oauth/token", (request) =>
  Effect.gen(function* () {
    const params = yield* request.urlParamsBody.pipe(
      Effect.map((body) => UrlParams.toRecord(body)),
      Effect.orElseSucceed((): Record<string, string | ReadonlyArray<string>> => ({})),
    );
    const raw = params.subject_token;
    const subject = (Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "")).toString().trim();

    if (localAuth().tokenMatches(subject)) {
      return reply({
        access_token: subject,
        issued_token_type: AccessTokenKind,
        token_type: "Bearer",
        expires_in: TOKEN_LIFETIME_SECONDS,
        scope: TOKEN_SCOPE,
      });
    }
    const legacy = subject === LEGACY_DESKTOP_CREDENTIAL;
    if (legacy) {
      console.warn(
        "[kora-ui] refused a desktop that predates the UI secret (sent the legacy credential): update Kora.app",
      );
    }
    return reply(
      {
        _tag: "HostAuthInvalidError",
        code: "auth_invalid",
        reason: subject === "" ? "missing_credential" : "invalid_credential",
        traceId: "kora-local",
        detail: legacy
          ? "This Kora app is older than its daemon, which now requires the local UI secret. Update Kora.app."
          : `Present the secret from ${defaultKoraHome()}/ui-token.`,
      },
      401,
    );
  }),
);

const session = get("/api/auth/session", () =>
  Effect.succeed(reply({ authenticated: true, auth: daemonConfig.auth })),
);

const websocketTicket = post("/api/auth/websocket-ticket", () =>
  Effect.sync(() => reply(localAuth().issueTicket())),
);

// ------------------------------------------------------------------ routes: threads and files

const threadSnapshot = get("/api/chat/threads/:threadId", () =>
  Effect.gen(function* () {
    const { threadId = "" } = yield* HttpRouter.params;
    const detail = chatEngine().getThreadDetail(threadId);
    return detail ? reply(detail) : notFound();
  }),
);

const attachment = get("/api/attachments/:threadId/:attachmentId", () =>
  Effect.gen(function* () {
    const { threadId = "", attachmentId = "" } = yield* HttpRouter.params;
    // Validate before the ids ever touch a path.
    if (!SAFE_ID.test(threadId) || !SAFE_ID.test(attachmentId)) return notFound();
    const found = yield* Effect.promise(() => chatEngine().getAttachment(threadId, attachmentId));
    if (!found) return notFound();
    const { contentType, headers } = attachmentHeaders(found.name, found.mimeType);
    return yield* sendFile(found.filePath, contentType, headers);
  }),
);

const blobFileRoute = get(
  "/api/blobs/:blobId/file",
  whenKoraOn((request) =>
    Effect.gen(function* () {
      const { blobId = "" } = yield* HttpRouter.params;
      const lookup = blobFile(blobId, query(request).get("path") ?? "");
      if ("reply" in lookup) return lookup.reply;
      const { file } = lookup;
      const { contentType, headers } = attachmentHeaders(file.name, file.mimeType);
      // Edited files must never be served from stale bytes.
      return yield* sendFile(file.filePath, contentType, {
        ...headers,
        "cache-control": "private, no-cache",
        ...blobFileVersionHeaders(file.filePath),
      });
    }),
  ),
);

const blobThumbnailRoute = get(
  "/api/blobs/:blobId/thumbnail",
  whenKoraOn((request) =>
    Effect.gen(function* () {
      const { blobId = "" } = yield* HttpRouter.params;
      const lookup = blobFile(blobId, query(request).get("path") ?? "");
      if ("reply" in lookup) return lookup.reply;
      const png = yield* Effect.promise(() => blobThumbnail(lookup.file.filePath));
      if (!png) return notFound();
      return yield* sendFile(png, "image/png", {
        "cache-control": "private, no-cache",
        ...blobFileVersionHeaders(lookup.file.filePath),
      });
    }),
  ),
);

// ------------------------------------------------------------------ routes: blob browser engine

const browserSource = () => host().blobs?.browserLive;

const browserEngine = get(
  "/api/blob-browser/engine",
  whenKoraOn(() =>
    Effect.gen(function* () {
      const source = browserSource();
      if (!source) return notFound();
      return yield* Effect.tryPromise(() => browserEngineSnapshot(source)).pipe(
        Effect.map((snapshot) => reply(jsonSafe(snapshot))),
        Effect.orElseSucceed(() => notFound()),
      );
    }),
  ),
);

const browserEngineInstall = post(
  "/api/blob-browser/engine/install",
  whenKoraOn(() =>
    Effect.gen(function* () {
      const source = browserSource();
      if (!source) return notFound();
      // The one-time download keeps running; callers poll the snapshot for progress.
      return yield* Effect.tryPromise(async () => {
        browserStartInstall(source);
        return browserEngineSnapshot(source);
      }).pipe(
        Effect.map((snapshot) => reply(jsonSafe(snapshot), 202)),
        Effect.orElseSucceed(() => notFound()),
      );
    }),
  ),
);

const browserClear = post(
  "/api/blob-browser/clear",
  whenKoraOn((request) =>
    Effect.gen(function* () {
      const source = browserSource();
      const blobId = query(request).get("blobId") ?? "";
      if (!source) return notFound();
      return yield* Effect.tryPromise(() => browserClearData(source, blobId)).pipe(
        Effect.map((r) =>
          r
            ? reply({ ok: true, cleared: r.cleared })
            : reply({ ok: false, reason: "unknown blob" }, 404),
        ),
        Effect.orElseSucceed(() =>
          reply({ ok: false, reason: "could not clear the browser data" }, 500),
        ),
      );
    }),
  ),
);

// ------------------------------------------------------------------ routes: code graph

// Every graph-store read goes through graphReader (a killable child process, graphReader.ts): the store is ~2 GB and a
// query that went pathological once froze the daemon's main thread for an hour (2026-10-14).
const graphSnapshot = get("/api/graph", (request) =>
  Effect.gen(function* () {
    const search = query(request);
    const cwd = search.get("cwd");
    const limit = Number.parseInt(search.get("limit") ?? "", 10);
    const result = yield* Effect.promise(() =>
      graphReader().snapshot({
        ...(cwd ? { cwd } : {}),
        ...(Number.isFinite(limit) ? { limit } : {}),
      }),
    ).pipe(Effect.orElseSucceed(() => ({ kind: "none" }) as const));
    if (result.kind === "ok") return reply(result.snapshot);
    if (result.kind === "busy") return reply({ reason: "graph busy, try again", busy: true }, 503);
    return notFound({ reason: "no indexed graph" });
  }),
);

/**
 * The repo code map (repoReport.ts): areas, hubs, entry points, bridges. JSON, or `format=md` for the Markdown a person can
 * save as GRAPH_REPORT.md. Same errors as the explorer snapshot: 404 not indexed (or its last full ingest died), 503 busy
 * (the reader child is occupied or timed out: never a verdict about the repo). Built in the reader child, cached per index.
 */
const graphReport = get("/api/graph/report", (request) =>
  Effect.gen(function* () {
    const search = query(request);
    const cwd = search.get("cwd");
    if (!cwd) return reply({ reason: "cwd required" }, 400);
    // A read that throws (the in-process fallback) is "no graph", never a 500 (Effect.promise would turn it into a defect).
    const result = yield* Effect.promise(() =>
      graphReader()
        .report(cwd)
        .catch(() => ({ kind: "none" }) as const),
    );
    if (result.kind === "busy") return reply({ reason: "graph busy, try again", busy: true }, 503);
    if (result.kind !== "ok") return notFound({ reason: "no indexed graph" });
    // Every value that leaves goes through jsonSafe: a nested `undefined` tears a wire frame (CLAUDE.md hazards).
    const report = jsonSafe(result.report) as RepoReport;
    if (search.get("format") === "md")
      return HttpServerResponse.text(renderRepoReportMarkdown(report), {
        contentType: "text/markdown; charset=utf-8",
      });
    return reply(report);
  }),
);

const graphStatus = get("/api/graph/status", (request) =>
  Effect.promise(() => graphReader().status(query(request).get("cwd") ?? undefined)).pipe(
    Effect.map((status) => reply(status)),
    Effect.orElseSucceed(() => reply({ indexed: false, busy: true })),
  ),
);

const graphReindex = post("/api/graph/reindex", (request) =>
  Effect.promise(async () => {
    const search = query(request);
    const cwd = search.get("cwd");
    if (!cwd) return reply({ ok: false, reason: "cwd required" }, 400);
    const target = await graphReader().target(cwd);
    if (!target) return reply({ ok: false, reason: "graph busy, try again", busy: true }, 503);
    if (target.bareRepo) return reply({ ok: false, reason: "bare-repo" }, 409);
    // Never overridable from the client, whatever flags it sends.
    if (!isSafeToIndex(target.indexRoot ?? cwd)) {
      return reply({ ok: false, reason: "unsafe-root" }, 409);
    }
    try {
      chatEngine().reindex(cwd, search.get("full") === "1");
    } catch {
      // Fire and forget: indexing problems surface on the status chip.
    }
    return reply({ ok: true });
  }),
);

const gitInit = post("/api/git/init", (request) =>
  Effect.promise(async () => {
    const cwd = query(request).get("cwd");
    if (!cwd) return reply({ ok: false, reason: "cwd required" }, 400);
    const result = await initGitRepo(cwd);
    const status = result.ok ? 200 : result.reason === "unsafe-root" ? 409 : 500;
    return reply(result, status);
  }),
);

// ------------------------------------------------------------------ routes: context lifecycle (B5)

const threadBrief = post("/api/thread/brief", (request) =>
  Effect.promise(async () => {
    const threadId = query(request).get("threadId");
    if (!threadId) return reply({ ok: false, reason: "threadId required" }, 400);
    const result = await chatEngine().threadBrief(threadId);
    return result ? reply({ ok: true, ...result }) : reply({ ok: false, reason: "no brief" }, 404);
  }),
);

const compactUndoStatus = get("/api/thread/compact-undo", (request) =>
  Effect.sync(() => {
    const threadId = query(request).get("threadId");
    return reply({ available: threadId ? chatEngine().canUndoCompaction(threadId) : false });
  }),
);

const compactUndo = post("/api/thread/compact-undo", (request) =>
  Effect.promise(async () => {
    const threadId = query(request).get("threadId");
    if (!threadId) return reply({ ok: false, reason: "threadId required" }, 400);
    const result = await chatEngine().undoCompaction(threadId);
    return reply(result, result.ok ? 200 : 409);
  }),
);

// ------------------------------------------------------------------ routes: graph quick answers (B17)

/**
 * The composer asks before sending: "who calls X" typed alone is answered from the code graph with no agent turn. The text is
 * in the body (it is the user's prompt), never the URL. `{discard:true}` drops the queued note when the user sends it anyway.
 * Always 200: `answer: null` means "send it to the agent".
 */
const graphQuickAnswer = post("/api/graph/quick-answer", (request) =>
  Effect.gen(function* () {
    if (!wantsJson(request)) return notJson();
    const body = asRecord(yield* readJson(request));
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    if (!threadId) return reply({ ok: false, reason: "threadId required" }, 400);
    if (body.discard === true) {
      chatEngine().discardQuickNotes(threadId);
      return reply({ ok: true });
    }
    const text = typeof body.text === "string" ? body.text : "";
    if (!text || text.length > 400) return reply({ ok: true, answer: null });
    const answer = yield* Effect.promise(() => chatEngine().quickAnswer(threadId, text));
    return reply(jsonSafe({ ok: true, answer }));
  }),
);

// ------------------------------------------------------------------ routes: workers

const workerTranscript = get("/api/workers/transcript", (request) =>
  Effect.sync(() => {
    const recordId = query(request).get("recordId");
    const runtime = host().runtime;
    const result = recordId && runtime.workerTranscript ? runtime.workerTranscript(recordId) : null;
    if (!result) return reply({ ok: false, reason: "no such worker" }, 404);
    return reply(jsonSafe({ ok: true, ...result }));
  }),
);

const workerWake = post("/api/workers/wake", (request) =>
  Effect.promise(async () => {
    const recordId = query(request).get("recordId");
    const wake = host().runtime.wakeWorker;
    if (!recordId || !wake) return reply({ ok: false, reason: "recordId required" }, 400);
    try {
      const { paneId } = await wake.call(host().runtime, recordId);
      return reply({ ok: true, paneId });
    } catch (error) {
      return reply({ ok: false, reason: errorMessage(error) }, 409);
    }
  }),
);

// ------------------------------------------------------------------ routes: Claude login, onboarding, diagnostics

const loginStatus = get("/api/claude/login", () =>
  Effect.sync(() => {
    const login = host().claudeLogin;
    return login ? reply(login.status()) : reply({ ok: false, reason: "login unavailable" }, 404);
  }),
);

const loginAction = post("/api/claude/login", (request) =>
  Effect.gen(function* () {
    const login = host().claudeLogin;
    if (!login) return reply({ ok: false, reason: "login unavailable" }, 404);
    if (!wantsJson(request)) return notJson();
    const body = asRecord(yield* readJson(request));
    switch (body.action) {
      case "start":
        return reply(yield* Effect.promise(() => login.start()));
      case "cancel":
        return reply(login.cancel());
      case "code":
        if (typeof body.code !== "string") break;
        return reply(login.submitCode(body.code));
    }
    return reply({ ok: false, reason: "action must be start, cancel or code" }, 400);
  }),
);

const recentProjects = get("/api/onboarding/recent-projects", () =>
  Effect.try(() => readRecentProjects()).pipe(
    Effect.map((projects) => reply({ projects })),
    Effect.orElseSucceed(() => reply({ projects: [] })),
  ),
);

const doctorReport = get("/api/doctor", (request) =>
  Effect.gen(function* () {
    const doctor = host().doctor;
    if (!doctor) return notFound({ reason: "doctor unavailable" });
    const search = query(request);
    const only = (search.get("only") ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    return yield* Effect.tryPromise(() =>
      doctor.run({
        cwd: search.get("cwd") || null,
        ...(only.length > 0 ? { only } : {}),
        probe: search.get("probe") !== "0",
      }),
    ).pipe(
      Effect.map((report) => {
        // A re-check after installing or signing in must refresh Settings > Agents too.
        applyHealthToAgents(report);
        return reply(report);
      }),
      Effect.orElseSucceed(() => reply({ ok: false, reason: "health checks failed" }, 500)),
    );
  }),
);

const doctorExport = post("/api/doctor/export", (request) =>
  Effect.gen(function* () {
    const doctor = host().doctor;
    if (!doctor) return notFound({ reason: "doctor unavailable" });
    if (!wantsJson(request)) return notJson();
    const body = asRecord(yield* readJson(request));
    const cwd = typeof body.cwd === "string" && body.cwd !== "" ? body.cwd : null;
    const dir = typeof body.dir === "string" && body.dir !== "" ? body.dir : null;
    return yield* Effect.tryPromise({
      try: () => doctor.exportBundle({ cwd, dir }),
      catch: errorMessage,
    }).pipe(
      Effect.map(({ path, bytes }) => reply({ ok: true, path, bytes })),
      // The message is written for the user ("Choose a folder inside your home folder."), never a stack.
      Effect.catch((reason) => Effect.succeed(reply({ ok: false, reason }, 400))),
    );
  }),
);

// ------------------------------------------------------------------ routes: usage limits

const usageSnapshot = () => ({
  claude: usageLimits().snapshot("claude"),
  codex: usageLimits().snapshot("codex"),
  antigravity: usageLimits().snapshot("antigravity"),
});

const usage = get("/api/usage", () => Effect.sync(() => reply(usageSnapshot())));

/** "Kora saved you": session (the given thread), week and all time, at API list prices. Reads local logs only. */
const savings = get("/api/savings", (request) =>
  Effect.sync(() => {
    const report = host().savings;
    if (!report) return notFound({ reason: "savings unavailable" });
    const threadId = query(request).get("threadId");
    const koraId = threadId ? chatEngine().koraThreadIdOf(threadId) : null;
    try {
      return reply(jsonSafe(report(koraId ?? threadId ?? null)));
    } catch {
      return reply({ ok: false, reason: "savings failed" }, 500);
    }
  }),
);

const usageRefresh = post("/api/usage/refresh", (request) =>
  Effect.gen(function* () {
    if (!wantsJson(request)) return notJson();
    const { provider, force } = asRecord(yield* readJson(request));
    const known = USAGE_AGENTS.find((agent) => agent === provider);
    const providers: ReadonlyArray<UsageProvider> = known ? [known] : USAGE_AGENTS;
    yield* Effect.promise(() =>
      usageLimits().refresh(providers, force === true ? { force: true } : { maxAgeMs: 60_000 }),
    );
    return reply({ ok: true, ...usageSnapshot() });
  }),
);

export const HttpRoutesLayer = Layer.mergeAll(
  reachability,
  descriptor,
  identity,
  tokenExchange,
  session,
  websocketTicket,
  threadSnapshot,
  attachment,
  blobFileRoute,
  blobThumbnailRoute,
  browserEngine,
  browserEngineInstall,
  browserClear,
  graphSnapshot,
  graphReport,
  graphStatus,
  graphReindex,
  graphQuickAnswer,
  gitInit,
  workerTranscript,
  threadBrief,
  compactUndoStatus,
  compactUndo,
  workerWake,
  loginStatus,
  loginAction,
  recentProjects,
  doctorReport,
  doctorExport,
  usage,
  savings,
  usageRefresh,
);
