// @effect-diagnostics globalConsoleInEffect:off globalConsole:off globalDate:off globalTimers:off nodeBuiltinImport:off -- the live view is a plain realtime boundary to the in-process blob browser host (frames, timers), not Effect code.
// The blob browser's live panel: `GET /blob-browser/:blobId/live` upgrades to a WebSocket that carries
//   server -> client   binary = one JPEG frame; text = JSON { t: 'state' | 'engine' | 'install' | 'busy' | 'pong' | 'error' ... }
//   client -> server   text JSON { t: 'mouse' | 'key' | 'text' | 'release' | 'approve' | 'keyframe' | 'install' | 'close' | 'ping' }
// Authorization is the node-level guard in front of every upgrade (`localAuth.ts`: Host, Origin and the UI secret as a
// header or - for browsers, which cannot set headers - a single-use `?wsTicket=`; see WIRING.md for the one-line ticket
// extension). This module adds: the blob must exist, at most one CONTROLLER at a time (others watch), frames are dropped
// when the socket's write buffer is high (latest picture wins, a keyframe follows once it drains), and a stuck client
// is dropped after a quiet period. The session core (`attachLiveSession`) knows nothing about HTTP: it talks to a
// `LiveSocket`, so it is unit-testable without a server.
import type { IncomingMessage } from "node:http";

import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

// ------------------------------------------------------------------ what we need from the runtime (structural)

export interface LiveTab {
  readonly index: number;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
}
export interface LiveApproval {
  readonly id: string;
  readonly summary: string;
  readonly url: string;
}
export interface LiveHostStatus {
  readonly running: boolean;
  readonly controller: "agent" | "user";
  readonly tabs: ReadonlyArray<LiveTab>;
  readonly viewers: number;
  readonly pendingApprovals: ReadonlyArray<LiveApproval>;
  readonly working: boolean;
  readonly tool: string | null;
}
export interface LiveHostEvents {
  frame: [jpeg: Buffer, meta: unknown];
  control: [state: unknown];
  tabs: [tabs: unknown];
  approval: [a: unknown];
  activity: [a: unknown];
  closed: [why: string];
}
/** The subset of the runtime's `BlobBrowserHost` the live route uses. */
export interface LiveBrowserHost {
  status(): LiveHostStatus;
  controlState(): { controller: "agent" | "user"; idleMs: number; releaseAfterMs: number };
  addViewer(): () => void;
  userInput(msg: LiveInput): Promise<void>;
  handBack(): void;
  keyframe(): Promise<void>;
  answerApproval(id: string, allow: boolean): boolean;
  /** The user picked another tab in the panel. */
  switchTab?(index: number): Promise<void>;
  on<K extends keyof LiveHostEvents>(event: K, fn: (...args: LiveHostEvents[K]) => void): unknown;
  off<K extends keyof LiveHostEvents>(event: K, fn: (...args: LiveHostEvents[K]) => void): unknown;
}
export interface EngineState {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly version: string | null;
  readonly downloadBytes: number | null;
}
export interface InstallProgressLike {
  readonly phase: string;
  readonly received: number;
  readonly total: number;
  readonly fraction: number;
}
export interface LiveBrowserSource {
  /** undefined for an unknown / archived blob. */
  get(blobId: string): LiveBrowserHost | undefined;
  engine: {
    status(): Promise<EngineState>;
    install(onProgress?: (p: InstallProgressLike) => void): Promise<void>;
  };
  settingsChanged?(blobId: string): Promise<void>;
  close(blobId: string): Promise<void>;
  /** Close the blob's browser and delete its profile (every sign-in). Optional: an older daemon lacks it. */
  clearData?(blobId: string): Promise<{ cleared: boolean }>;
}

// ------------------------------------------------------------------ protocol

export type LiveInput =
  | {
      t: "mouse";
      type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel";
      x: number;
      y: number;
      button?: "none" | "left" | "middle" | "right";
      buttons?: number;
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }
  | {
      t: "key";
      type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
      key: string;
      code?: string;
      text?: string;
      vk?: number;
      modifiers?: number;
    }
  | { t: "text"; text: string };

export type ClientMessage =
  | LiveInput
  | { t: "release" }
  | { t: "approve"; id: string; allow: boolean }
  | { t: "tab"; index: number }
  | { t: "keyframe" }
  | { t: "install" }
  | { t: "close" }
  | { t: "ping"; ts: number };

const LIVE_VIEWPORT = { width: 1280, height: 800 } as const;
/** Writes queued above this many bytes on the socket mean the client cannot keep up: frames are dropped. */
export const HIGH_WATER_BYTES = 512 * 1024;
const MAX_MESSAGE_BYTES = 128 * 1024;
export const MAX_VIEWERS = 4;
const MAX_QUEUED_INPUT = 200;

/** `/blob-browser/<blobId>/live` - the paths the node-level guard must let a `?wsTicket=` through for (browsers cannot send headers). */
export const LIVE_PATH_RE = /^\/blob-browser\/[A-Za-z0-9_-]{1,80}\/live$/;
const SAFE_BLOB_ID = /^[A-Za-z0-9_-]{1,80}$/;

const FINITE = (n: unknown, lo: number, hi: number): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;
const optInt = (n: unknown, lo: number, hi: number): number | undefined | null =>
  n === undefined ? undefined : FINITE(n, lo, hi) ? Math.trunc(n) : null;

/** Validate one client message. Anything malformed is `null` (ignored): the socket is the user's, but a bug or a
 *  hostile local page must still not be able to push garbage into CDP. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let m: Record<string, unknown>;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    m = v as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (m.t) {
    case "mouse": {
      if (!["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"].includes(m.type as string))
        return null;
      if (!FINITE(m.x, -10, 10_000) || !FINITE(m.y, -10, 10_000)) return null;
      const button = m.button === undefined ? undefined : m.button;
      if (button !== undefined && !["none", "left", "middle", "right"].includes(button as string))
        return null;
      const buttons = optInt(m.buttons, 0, 31);
      const clickCount = optInt(m.clickCount, 0, 3);
      const modifiers = optInt(m.modifiers, 0, 15);
      if (buttons === null || clickCount === null || modifiers === null) return null;
      const dx =
        m.deltaX === undefined ? undefined : FINITE(m.deltaX, -20_000, 20_000) ? m.deltaX : null;
      const dy =
        m.deltaY === undefined ? undefined : FINITE(m.deltaY, -20_000, 20_000) ? m.deltaY : null;
      if (dx === null || dy === null) return null;
      return {
        t: "mouse",
        type: m.type as never,
        x: m.x,
        y: m.y,
        ...(button ? { button: button as never } : {}),
        ...(buttons !== undefined ? { buttons } : {}),
        ...(clickCount !== undefined ? { clickCount } : {}),
        ...(dx !== undefined ? { deltaX: dx } : {}),
        ...(dy !== undefined ? { deltaY: dy } : {}),
        ...(modifiers !== undefined ? { modifiers } : {}),
      };
    }
    case "key": {
      if (!["keyDown", "keyUp", "rawKeyDown", "char"].includes(m.type as string)) return null;
      if (typeof m.key !== "string" || m.key.length === 0 || m.key.length > 32) return null;
      if (m.code !== undefined && (typeof m.code !== "string" || m.code.length > 32)) return null;
      if (m.text !== undefined && (typeof m.text !== "string" || m.text.length > 8)) return null;
      const vk = optInt(m.vk, 0, 255);
      const modifiers = optInt(m.modifiers, 0, 15);
      if (vk === null || modifiers === null) return null;
      return {
        t: "key",
        type: m.type as never,
        key: m.key,
        ...(m.code !== undefined ? { code: m.code as string } : {}),
        ...(m.text !== undefined ? { text: m.text as string } : {}),
        ...(vk !== undefined ? { vk } : {}),
        ...(modifiers !== undefined ? { modifiers } : {}),
      };
    }
    case "text":
      return typeof m.text === "string" && m.text.length > 0 && m.text.length <= 20_000
        ? { t: "text", text: m.text }
        : null;
    case "release":
    case "keyframe":
    case "install":
    case "close":
      return { t: m.t };
    case "approve":
      return typeof m.id === "string" &&
        m.id.length > 0 &&
        m.id.length <= 64 &&
        typeof m.allow === "boolean"
        ? { t: "approve", id: m.id, allow: m.allow }
        : null;
    case "tab":
      return FINITE(m.index, 0, 20) ? { t: "tab", index: Math.trunc(m.index) } : null;
    case "ping":
      return FINITE(m.ts, 0, 1e15) ? { t: "ping", ts: m.ts } : null;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ the session

export interface LiveSocket {
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  /** Bytes queued on the connection and not yet written to the OS. */
  bufferedAmount(): number;
  close(code?: number, reason?: string): void;
}

export interface LiveSession {
  /** A text message from the client (already decoded). */
  onMessage(raw: string): void;
  dispose(): void;
  stats(): {
    framesSent: number;
    framesDropped: number;
    bytesSent: number;
    inputForwarded: number;
    inputIgnored: number;
  };
  readonly isController: boolean;
}

/** Who may send input to which host: one controller at a time, the rest watch. */
const controllers = new WeakMap<LiveBrowserHost, LiveSession>();
const sessionsBySource = new WeakMap<
  LiveBrowserSource,
  Set<LiveSession & { pushEngine(): void; pushInstall(m: Record<string, unknown>): void }>
>();
const installs = new WeakMap<LiveBrowserSource, Promise<void>>();

export interface AttachOptions {
  /** Drop the connection after this long without any client message (the client pings every few seconds). */
  idleTimeoutMs?: number;
  highWaterBytes?: number;
  now?: () => number;
}

export function attachLiveSession(
  source: LiveBrowserSource,
  blobId: string,
  host: LiveBrowserHost,
  sock: LiveSocket,
  o: AttachOptions = {},
): LiveSession | null {
  const now = o.now ?? Date.now;
  const highWater = o.highWaterBytes ?? HIGH_WATER_BYTES;
  const idleTimeoutMs = o.idleTimeoutMs ?? 45_000;
  let disposed = false;
  let framesSent = 0;
  let framesDropped = 0;
  let bytesSent = 0;
  let inputForwarded = 0;
  let inputIgnored = 0;
  let needKeyframe = false;
  let lastSeen = now();
  let lastBusyNotice = 0;
  let stateTimer: NodeJS.Timeout | null = null;
  let drainTimer: NodeJS.Timeout | null = null;

  const sendJson = (m: Record<string, unknown>) => {
    if (disposed) return;
    try {
      sock.sendText(JSON.stringify(m));
    } catch {
      /* the socket is going away: dispose follows */
    }
  };

  if (host.status().viewers >= MAX_VIEWERS) {
    sendJson({
      t: "error",
      code: "too_many_viewers",
      message: "This blob's browser is already open in several windows.",
    });
    sock.close(1013, "too many viewers");
    return null;
  }

  const detachViewer = host.addViewer();

  const stateMessage = () => {
    const st = host.status();
    const c = host.controlState();
    return {
      t: "state",
      blobId,
      running: st.running,
      working: st.working,
      tool: st.tool,
      controller: c.controller,
      idleMs: c.idleMs,
      releaseAfterMs: c.releaseAfterMs,
      youControl: controllers.get(host) === session,
      tabs: st.tabs.map((x) => ({ index: x.index, title: x.title, url: x.url, active: x.active })),
      approvals: st.pendingApprovals.map((a) => ({ id: a.id, summary: a.summary, url: a.url })),
      viewport: LIVE_VIEWPORT,
    };
  };
  const pushState = () => {
    if (disposed || stateTimer) return;
    // coalesce bursts (a navigation fires tabs/activity/control within a few ms)
    stateTimer = setTimeout(() => {
      stateTimer = null;
      sendJson(stateMessage());
    }, 25);
    stateTimer.unref();
  };

  // ---- frames, with backpressure: latest picture wins
  const onFrame = (jpeg: Buffer) => {
    if (disposed) return;
    if (sock.bufferedAmount() > highWater) {
      framesDropped++;
      needKeyframe = true;
      armDrain();
      return;
    }
    try {
      sock.sendBinary(jpeg);
      framesSent++;
      bytesSent += jpeg.byteLength;
    } catch {
      /* closing */
    }
  };
  const armDrain = () => {
    if (drainTimer || disposed) return;
    drainTimer = setInterval(() => {
      if (disposed) return;
      if (sock.bufferedAmount() <= highWater / 4) {
        clearInterval(drainTimer!);
        drainTimer = null;
        if (needKeyframe) {
          needKeyframe = false;
          void host.keyframe().catch(() => {});
        }
      }
    }, 100);
    drainTimer.unref();
  };

  // ---- host events -> state
  const onControl = () => {
    if (host.controlState().controller === "agent" && controllers.get(host) === session)
      controllers.delete(host);
    pushState();
  };
  const onAny = () => pushState();
  host.on("frame", onFrame);
  host.on("control", onControl);
  host.on("tabs", onAny);
  host.on("approval", onAny);
  host.on("activity", onAny);
  host.on("closed", onAny);

  // ---- input, in order, with hover coalescing
  const queue: LiveInput[] = [];
  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && !disposed) {
        const msg = queue.shift()!;
        inputForwarded++;
        await host.userInput(msg).catch(() => {});
      }
    } finally {
      pumping = false;
    }
  };
  const enqueue = (msg: LiveInput) => {
    const last = queue[queue.length - 1];
    if (
      msg.t === "mouse" &&
      msg.type === "mouseMoved" &&
      last?.t === "mouse" &&
      last.type === "mouseMoved"
    ) {
      queue[queue.length - 1] = msg; // coalesce pointer moves: only the latest position matters
    } else if (queue.length >= MAX_QUEUED_INPUT) {
      if (msg.t === "mouse" && msg.type === "mouseMoved") return;
      inputIgnored++;
      return;
    } else queue.push(msg);
    void pump();
  };

  const isHover = (m: LiveInput) => m.t === "mouse" && m.type === "mouseMoved" && !m.buttons;

  const handleInput = (msg: LiveInput) => {
    const holder = controllers.get(host);
    const userDriving = host.controlState().controller === "user";
    if (holder && holder !== session && userDriving) {
      // someone else is driving: this window only watches
      inputIgnored++;
      const t = now();
      if (!isHover(msg) && t - lastBusyNotice > 1500) {
        lastBusyNotice = t;
        sendJson({ t: "busy", message: "Another Kora window is driving this browser." });
      }
      return;
    }
    if (isHover(msg) && !userDriving) {
      inputIgnored++; // pointer moves alone never take over
      return;
    }
    if (!holder || holder !== session) controllers.set(host, session);
    enqueue(msg);
  };

  const idleCheck = setInterval(
    () => {
      if (disposed) return;
      if (now() - lastSeen > idleTimeoutMs) {
        sock.close(1001, "idle");
        dispose();
      }
    },
    Math.max(50, Math.min(15_000, idleTimeoutMs / 3)),
  );
  idleCheck.unref();

  const pushEngine = () => {
    void source.engine
      .status()
      .then((e) => sendJson({ t: "engine", ...e }))
      .catch(() => {});
  };
  const pushInstall = (m: Record<string, unknown>) => sendJson({ t: "install", ...m });

  const onMessage = (raw: string) => {
    if (disposed) return;
    lastSeen = now();
    const msg = parseClientMessage(raw);
    if (!msg) return;
    switch (msg.t) {
      case "mouse":
      case "key":
      case "text":
        return handleInput(msg);
      case "release":
        // only the window that is driving (or any window when nobody holds control) can hand the browser back
        if (controllers.get(host) === session || !controllers.get(host)) host.handBack();
        return;
      case "approve":
        if (!host.answerApproval(msg.id, msg.allow)) sendJson({ t: "approval-gone", id: msg.id });
        return;
      case "tab":
        // choosing a tab is the user's own action: it takes over like any other input
        if (
          controllers.get(host) &&
          controllers.get(host) !== session &&
          host.controlState().controller === "user"
        )
          return;
        controllers.set(host, session);
        void host.switchTab?.(msg.index)?.catch(() => {});
        return;
      case "keyframe":
        void host.keyframe().catch(() => {});
        return;
      case "ping":
        return sendJson({ t: "pong", ts: msg.ts });
      case "close":
        void source.close(blobId).catch(() => {});
        return;
      case "install":
        return void startInstall(source);
    }
  };

  const dispose = () => {
    if (disposed) return;
    if (stateTimer) clearTimeout(stateTimer);
    disposed = true;
    if (drainTimer) clearInterval(drainTimer);
    clearInterval(idleCheck);
    queue.length = 0;
    host.off("frame", onFrame);
    host.off("control", onControl);
    host.off("tabs", onAny);
    host.off("approval", onAny);
    host.off("activity", onAny);
    host.off("closed", onAny);
    const mine = controllers.get(host) === session;
    if (mine) {
      controllers.delete(host);
      // the person driving left: the agent gets its browser back (the last viewer leaving does this inside the host too)
      host.handBack();
    }
    detachViewer();
    sessionsBySource.get(source)?.delete(session as never);
  };

  const session: LiveSession & {
    pushEngine(): void;
    pushInstall(m: Record<string, unknown>): void;
  } = {
    onMessage,
    dispose,
    stats: () => ({ framesSent, framesDropped, bytesSent, inputForwarded, inputIgnored }),
    get isController() {
      return controllers.get(host) === session;
    },
    pushEngine,
    pushInstall,
  };
  let set = sessionsBySource.get(source);
  if (!set) sessionsBySource.set(source, (set = new Set()));
  set.add(session);

  sendJson({ ...stateMessage(), t: "hello" });
  pushEngine();
  void host.keyframe().catch(() => {}); // a picture right away (a static page emits none)
  return session;
}

/** Where the shared engine install stands, for the plain status endpoint (the live socket is not needed to ask). */
export interface EngineInstallState {
  readonly state: "idle" | "running" | "done" | "error";
  readonly phase: string;
  readonly received: number;
  readonly total: number;
  readonly fraction: number;
  readonly message: string | null;
}
const IDLE_INSTALL: EngineInstallState = {
  state: "idle",
  phase: "",
  received: 0,
  total: 0,
  fraction: 0,
  message: null,
};
const installStates = new WeakMap<LiveBrowserSource, EngineInstallState>();

/** Engine status + install progress over plain HTTP (`GET /api/blob-browser/engine`): works with no socket open. */
export async function browserEngineSnapshot(
  source: LiveBrowserSource,
): Promise<EngineState & { install: EngineInstallState }> {
  const engine = await source.engine.status();
  const known = installStates.get(source) ?? IDLE_INSTALL;
  // a finished install is only "done" while the engine really is there; a failed one stays visible until the next try
  const install =
    engine.installed && known.state !== "running"
      ? { ...IDLE_INSTALL, state: "done" as const, fraction: 1, phase: "done" }
      : known;
  return {
    supported: engine.supported,
    installed: engine.installed,
    version: engine.version,
    downloadBytes: engine.downloadBytes,
    install,
  };
}

/** One shared engine install: every open panel sees the same progress. */
function startInstall(source: LiveBrowserSource): Promise<void> {
  let p = installs.get(source);
  if (p) return p;
  installStates.set(source, { ...IDLE_INSTALL, state: "running", phase: "download" });
  const each = (
    fn: (s: { pushEngine(): void; pushInstall(m: Record<string, unknown>): void }) => void,
  ) => {
    for (const s of sessionsBySource.get(source) ?? []) {
      try {
        fn(s);
      } catch {
        /* a dead session */
      }
    }
  };
  let last = 0;
  each((s) =>
    s.pushInstall({ phase: "download", received: 0, total: 0, fraction: 0, state: "running" }),
  );
  p = source.engine
    .install((pr) => {
      const t = Date.now();
      if (t - last < 120 && pr.phase === "download") return; // ~8 updates/s is plenty for a progress bar
      last = t;
      installStates.set(source, {
        state: "running",
        phase: pr.phase,
        received: pr.received,
        total: pr.total,
        fraction: pr.fraction,
        message: null,
      });
      each((s) =>
        s.pushInstall({
          phase: pr.phase,
          received: pr.received,
          total: pr.total,
          fraction: pr.fraction,
          state: "running",
        }),
      );
    })
    .then(() => {
      installStates.set(source, {
        state: "done",
        phase: "done",
        received: 0,
        total: 0,
        fraction: 1,
        message: null,
      });
      each((s) => {
        s.pushInstall({ phase: "done", received: 0, total: 0, fraction: 1, state: "done" });
        s.pushEngine();
      });
    })
    .catch((e: unknown) => {
      const message = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);
      installStates.set(source, {
        state: "error",
        phase: "error",
        received: 0,
        total: 0,
        fraction: 0,
        message,
      });
      each((s) =>
        s.pushInstall({
          phase: "error",
          received: 0,
          total: 0,
          fraction: 0,
          state: "error",
          message,
        }),
      );
    })
    .finally(() => {
      installs.delete(source);
    });
  installs.set(source, p);
  return p;
}

// ------------------------------------------------------------------ plain helpers for the status / hand-back / close / install RPCs

export interface BrowserStatusWire {
  readonly running: boolean;
  readonly controller: "agent" | "user";
  readonly working: boolean;
  readonly tool: string | null;
  readonly tabs: ReadonlyArray<LiveTab>;
  readonly approvals: ReadonlyArray<LiveApproval>;
  readonly engine: EngineState;
}

export async function browserStatus(
  source: LiveBrowserSource,
  blobId: string,
): Promise<BrowserStatusWire | null> {
  const host = SAFE_BLOB_ID.test(blobId) ? source.get(blobId) : undefined;
  if (!host) return null;
  const st = host.status();
  return {
    running: st.running,
    controller: host.controlState().controller,
    working: st.working,
    tool: st.tool,
    tabs: st.tabs.map((x) => ({ index: x.index, title: x.title, url: x.url, active: x.active })),
    approvals: st.pendingApprovals.map((a) => ({ id: a.id, summary: a.summary, url: a.url })),
    engine: await source.engine.status(),
  };
}
export function browserHandBack(source: LiveBrowserSource, blobId: string): boolean {
  const host = SAFE_BLOB_ID.test(blobId) ? source.get(blobId) : undefined;
  if (!host) return false;
  host.handBack();
  return true;
}
export async function browserClose(source: LiveBrowserSource, blobId: string): Promise<boolean> {
  if (!SAFE_BLOB_ID.test(blobId) || !source.get(blobId)) return false;
  await source.close(blobId);
  return true;
}
/** "Clear browser data" (`POST /api/blob-browser/clear?blobId=`): null when the blob is unknown or the daemon can't. */
export async function browserClearData(
  source: LiveBrowserSource,
  blobId: string,
): Promise<{ cleared: boolean } | null> {
  if (!SAFE_BLOB_ID.test(blobId) || !source.get(blobId) || !source.clearData) return null;
  return source.clearData(blobId);
}
/** Install the engine (shared, idempotent). Progress also reaches every open panel. */
/** Start the shared install without waiting for it (`POST /api/blob-browser/engine/install`); progress is read from `browserEngineSnapshot`. */
export function browserStartInstall(source: LiveBrowserSource): void {
  void startInstall(source);
}
function browserInstall(
  source: LiveBrowserSource,
  onProgress?: (p: InstallProgressLike) => void,
): Promise<void> {
  if (!onProgress) return startInstall(source);
  return installs.get(source) ?? source.engine.install(onProgress);
}

// ------------------------------------------------------------------ the HTTP route

/** Node's write queue for this upgraded connection: the honest "how far behind is the client" number. */
function queuedBytes(req: IncomingMessage): number {
  const s = req.socket;
  return s ? (s.writableLength ?? 0) : 0;
}

/**
 * `GET /blob-browser/:blobId/live`. `getSource` is read per connection (the blob runtime may not exist yet or may be
 * an older daemon without browsers): no source or an unknown blob answers 404 JSON before the upgrade.
 */
export const blobBrowserLiveRoute = (getSource: () => LiveBrowserSource | undefined) =>
  HttpRouter.add(
    "GET",
    "/blob-browser/:blobId/live",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const blobId = params.blobId ?? "";
      const source = getSource();
      const host = source && SAFE_BLOB_ID.test(blobId) ? source.get(blobId) : undefined;
      if (!source || !host) {
        return HttpServerResponse.jsonUnsafe(
          { _tag: "HostResourceNotFoundError" },
          { status: 404 },
        );
      }
      const socket = yield* Effect.orDie(request.upgrade);
      const write = yield* socket.writer;
      const fork = Effect.runForkWith(yield* Effect.context<never>());
      const send = (chunk: string | Uint8Array | Socket.CloseEvent) => {
        fork(Effect.ignore(write(chunk)));
      };
      const node = request.source as IncomingMessage;
      const session = attachLiveSession(source, blobId, host, {
        sendText: (t) => send(t),
        sendBinary: (b) => send(b),
        bufferedAmount: () => queuedBytes(node),
        close: (code, reason) => send(new Socket.CloseEvent(code ?? 1000, reason)),
      });
      if (!session) return HttpServerResponse.empty();
      yield* Effect.addFinalizer(() => Effect.sync(() => session.dispose()));
      yield* socket
        .runRaw((data) => {
          if (typeof data === "string") session.onMessage(data);
          // binary client messages are not part of the protocol
        })
        .pipe(
          Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
          Effect.orDie,
        );
      return HttpServerResponse.empty();
    }),
  );
