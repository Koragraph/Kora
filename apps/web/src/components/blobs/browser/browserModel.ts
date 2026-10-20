// The live browser panel's pure logic: what the daemon says (wire shapes + a reducer), the status the panel shows, the
// pointer/keyboard translation (coordinates are the remote page's CSS pixels, never device or canvas-backing pixels), the
// take-over countdown, and the small formatters. No React, no DOM globals: everything here is unit-tested.
// ------------------------------------------------------------------ wire (mirrors packages/ui-server/src/handlers/blobs-browser.ts)

export interface Viewport {
  readonly width: number;
  readonly height: number;
}
export interface WireTab {
  readonly index: number;
  readonly title: string;
  readonly url: string;
  readonly active: boolean;
}
export interface WireApproval {
  readonly id: string;
  readonly summary: string;
  readonly url: string;
}
export interface EngineInfo {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly version: string | null;
  readonly downloadBytes: number | null;
}
export interface InstallState {
  readonly state: "idle" | "running" | "done" | "error";
  readonly phase: "download" | "verify" | "extract" | "warm" | "done" | "error";
  readonly received: number;
  readonly total: number;
  readonly fraction: number;
  readonly message: string | null;
}

export type ServerMessage =
  | {
      t: "hello" | "state";
      running: boolean;
      working: boolean;
      tool: string | null;
      controller: "agent" | "user";
      idleMs: number;
      releaseAfterMs: number;
      youControl: boolean;
      tabs: ReadonlyArray<WireTab>;
      approvals: ReadonlyArray<WireApproval>;
      viewport: Viewport;
    }
  | ({ t: "engine" } & EngineInfo)
  | {
      t: "install";
      state: "running" | "done" | "error";
      phase: InstallState["phase"];
      received: number;
      total: number;
      fraction: number;
      message?: string;
    }
  | { t: "busy"; message: string }
  | { t: "approval-gone"; id: string }
  | { t: "error"; code: string; message: string }
  | { t: "pong"; ts: number };

export type ClientMessage =
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
  | { t: "text"; text: string }
  | { t: "release" }
  | { t: "approve"; id: string; allow: boolean }
  | { t: "tab"; index: number }
  | { t: "keyframe" }
  | { t: "install" }
  | { t: "close" }
  | { t: "ping"; ts: number };

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const m = JSON.parse(raw) as { t?: unknown };
    return m && typeof m === "object" && typeof m.t === "string" ? (m as ServerMessage) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ state

export type ConnectionState = "connecting" | "open" | "reconnecting" | "unavailable";

export interface BrowserState {
  readonly connection: ConnectionState;
  readonly running: boolean;
  readonly working: boolean;
  readonly tool: string | null;
  /** The last tool the agent ran, kept while the chip holds "Working" between two calls. */
  readonly lastTool: string | null;
  /** Until when the panel still reads "Working" after a call ended (the model thinks between two browser calls). */
  readonly workedUntil: number;
  readonly controller: "agent" | "user";
  readonly youControl: boolean;
  readonly releaseAfterMs: number;
  readonly tabs: ReadonlyArray<WireTab>;
  readonly approvals: ReadonlyArray<WireApproval>;
  readonly viewport: Viewport;
  readonly engine: EngineInfo | null;
  readonly install: InstallState;
  /** Another window of this app is driving: this one watches. */
  readonly busyNotice: string | null;
  readonly hasFrame: boolean;
  readonly error: string | null;
}

/** How long "Working" holds after the agent's last browser call ended. */
export const WORK_HOLD_MS = 8000;

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 };

export const initialBrowserState: BrowserState = {
  connection: "connecting",
  running: false,
  working: false,
  tool: null,
  lastTool: null,
  workedUntil: 0,
  controller: "agent",
  youControl: false,
  releaseAfterMs: 8000,
  tabs: [],
  approvals: [],
  viewport: DEFAULT_VIEWPORT,
  engine: null,
  install: { state: "idle", phase: "download", received: 0, total: 0, fraction: 0, message: null },
  busyNotice: null,
  hasFrame: false,
  error: null,
};

export type BrowserAction =
  | { type: "connection"; connection: ConnectionState }
  | { type: "message"; message: ServerMessage }
  | { type: "frame" }
  | { type: "install-requested" }
  | { type: "clear-busy" };

export function browserReducer(s: BrowserState, a: BrowserAction): BrowserState {
  switch (a.type) {
    case "connection":
      return {
        ...s,
        connection: a.connection,
        ...(a.connection === "open" ? { error: null } : {}),
      };
    case "frame":
      return s.hasFrame ? s : { ...s, hasFrame: true };
    case "install-requested":
      return {
        ...s,
        install: { ...s.install, state: "running", phase: "download", fraction: 0, message: null },
      };
    case "clear-busy":
      return s.busyNotice ? { ...s, busyNotice: null } : s;
    case "message": {
      const m = a.message;
      switch (m.t) {
        case "hello":
        case "state":
          return {
            ...s,
            running: m.running,
            working: m.working,
            tool: m.tool,
            // Calls are short and the model thinks for seconds between them: a chip that said "Idle" in every gap read
            // as stuck while the agent was clicking. "Working" holds for WORK_HOLD_MS after the last call.
            lastTool: m.tool ?? s.lastTool,
            workedUntil: m.working || s.working ? Date.now() + WORK_HOLD_MS : s.workedUntil,
            controller: m.controller,
            youControl: m.youControl,
            releaseAfterMs: m.releaseAfterMs,
            tabs: m.tabs,
            approvals: m.approvals,
            viewport:
              m.viewport && m.viewport.width > 0 && m.viewport.height > 0 ? m.viewport : s.viewport,
            // a state that says nobody is driving clears any "another window" notice
            busyNotice: m.controller === "agent" ? null : s.busyNotice,
            // a browser that is no longer running has no live picture (the last frame stays as a dimmed backdrop)
            hasFrame: s.hasFrame,
          };
        case "engine": {
          const { t: _t, ...engine } = m;
          return {
            ...s,
            engine,
            install:
              engine.installed && s.install.state !== "running"
                ? { ...s.install, state: engine.installed ? "done" : s.install.state }
                : s.install,
          };
        }
        case "install":
          return {
            ...s,
            install: {
              state: m.state,
              phase: m.phase,
              received: m.received,
              total: m.total,
              fraction: m.fraction,
              message: m.message ?? null,
            },
          };
        case "busy":
          return { ...s, busyNotice: m.message };
        case "error":
          return { ...s, error: m.message };
        default:
          return s;
      }
    }
  }
}

// ------------------------------------------------------------------ what the panel shows

export type PanelStatus =
  | "setup"
  | "idle"
  | "working"
  | "needs-you"
  | "driving"
  | "closed"
  | "offline";

export interface StatusView {
  readonly status: PanelStatus;
  readonly label: string;
  /** One line under the label, when there is something useful to say. */
  readonly detail: string | null;
}

const TOOL_VERBS: Record<string, string> = {
  browser_navigate: "Opening a page",
  browser_snapshot: "Reading the page",
  browser_click: "Clicking",
  browser_type: "Typing",
  browser_select: "Choosing an option",
  browser_press_key: "Pressing a key",
  browser_scroll: "Scrolling",
  browser_back: "Going back",
  browser_screenshot: "Taking a screenshot",
  browser_wait_for: "Waiting for the page",
  browser_extract: "Reading the page",
  browser_tabs: "Switching tabs",
};
const toolVerb = (tool: string | null): string =>
  tool ? (TOOL_VERBS[tool] ?? "Working") : "Working";

export function deriveStatus(s: BrowserState, now: number = Date.now()): StatusView {
  if (s.engine && !s.engine.installed)
    return { status: "setup", label: "Set up needed", detail: null };
  if (s.connection === "unavailable")
    return {
      status: "offline",
      label: "Unavailable",
      detail: "Kora can't reach the browser service.",
    };
  if (s.connection !== "open")
    return {
      status: "offline",
      label: s.connection === "connecting" ? "Connecting" : "Reconnecting",
      detail: null,
    };
  if (s.approvals.length > 0)
    return { status: "needs-you", label: "Needs you", detail: "Waiting for your OK" };
  if (s.controller === "user")
    return { status: "driving", label: "You're driving", detail: "Paused while you drive" };
  if (!s.running) return { status: "closed", label: "Closed", detail: "Opens when it is needed" };
  if (s.working) return { status: "working", label: "Working", detail: toolVerb(s.tool) };
  if (now < s.workedUntil)
    return { status: "working", label: "Working", detail: toolVerb(s.tool ?? s.lastTool) };
  return { status: "idle", label: "Idle", detail: null };
}

/** The line under the picture: what is going on in a few words, never instructions longer than a sentence. */
export function footerHint(
  view: StatusView,
  o: {
    running: boolean;
    showPicture: boolean;
    driving: boolean;
    watchingOnly: boolean;
    approval: boolean;
    name: string;
  },
): string {
  if (o.approval) return `${o.name} is waiting for your answer`;
  if (o.driving) return "Type, click and scroll as usual";
  if (o.watchingOnly) return "Watching only";
  if (view.status === "working") return `${o.name}: ${view.detail ?? "working"}…`;
  if (o.running && o.showPicture) return "Click the page to take over";
  return "\u00a0";
}

/** True when there is nothing to watch yet: no live picture and no real page in any tab. */
export function isEmptyPage(s: BrowserState): boolean {
  if (!s.running) return !s.hasFrame;
  const active = s.tabs.find((t) => t.active) ?? s.tabs[0];
  const blank = !active || active.url === "" || active.url === "about:blank";
  return blank && s.tabs.length <= 1;
}

// ------------------------------------------------------------------ the take-over countdown

/** Milliseconds until the daemon hands the browser back on its own; null when the user is not driving. */
export function handBackRemaining(opts: {
  driving: boolean;
  lastInputAt: number;
  releaseAfterMs: number;
  now: number;
}): number | null {
  if (!opts.driving) return null;
  return Math.max(0, opts.releaseAfterMs - (opts.now - opts.lastInputAt));
}
/** The countdown only shows once it is near, so a person who is actively typing never sees a ticking clock. */
export const COUNTDOWN_SHOWS_AT_MS = 5000;
export const countdownSeconds = (remainingMs: number): number =>
  Math.max(1, Math.ceil(remainingMs / 1000));

// ------------------------------------------------------------------ pointer mapping

export interface Box {
  readonly height: number;
  readonly width: number;
  readonly left: number;
  readonly top: number;
}

/**
 * Where a pointer is on the REMOTE page, in its CSS pixels (the 1280x800 viewport the browser reports). Everything is in
 * CSS pixels of the local page: `rect` comes from getBoundingClientRect and the event's clientX/Y, so the device pixel
 * ratio, browser zoom and the canvas' backing-store size never enter into it (a canvas whose width attribute is 2560 but
 * whose CSS box is 640 wide maps exactly like a 640 one). The frame is fitted inside the box with `contain` (a
 * letterboxed expanded view): points on the bars map to null; points on the picture clamp to the viewport.
 */
export function mapPointer(
  clientX: number,
  clientY: number,
  rect: Box,
  viewport: Viewport,
): { x: number; y: number } | null {
  if (!(rect.width > 0) || !(rect.height > 0) || !(viewport.width > 0) || !(viewport.height > 0))
    return null;
  const fit = containFit(rect, viewport);
  const px = clientX - rect.left - fit.offsetX;
  const py = clientY - rect.top - fit.offsetY;
  if (px < 0 || py < 0 || px > fit.width || py > fit.height) return null;
  return {
    x: clamp((px * viewport.width) / fit.width, 0, viewport.width - 1),
    y: clamp((py * viewport.height) / fit.height, 0, viewport.height - 1),
  };
}
/** Like `mapPointer` but never null: a drag that leaves the picture keeps tracking at the nearest edge. */
export function mapPointerClamped(
  clientX: number,
  clientY: number,
  rect: Box,
  viewport: Viewport,
): { x: number; y: number } {
  const fit = containFit(rect, viewport);
  if (!(fit.width > 0) || !(fit.height > 0)) return { x: 0, y: 0 };
  return {
    x: clamp(
      ((clientX - rect.left - fit.offsetX) * viewport.width) / fit.width,
      0,
      viewport.width - 1,
    ),
    y: clamp(
      ((clientY - rect.top - fit.offsetY) * viewport.height) / fit.height,
      0,
      viewport.height - 1,
    ),
  };
}
export function containFit(
  rect: Box,
  viewport: Viewport,
): { width: number; height: number; offsetX: number; offsetY: number; scale: number } {
  if (!(rect.width > 0) || !(rect.height > 0) || !(viewport.width > 0) || !(viewport.height > 0))
    return { width: 0, height: 0, offsetX: 0, offsetY: 0, scale: 0 };
  const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
  const width = viewport.width * scale;
  const height = viewport.height * scale;
  return {
    width,
    height,
    offsetX: (rect.width - width) / 2,
    offsetY: (rect.height - height) / 2,
    scale,
  };
}
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The size of a box of width `w` for the viewport's aspect ratio (so the narrow panel needs no letterboxing). */
export const heightForWidth = (w: number, vp: Viewport): number =>
  Math.round((w * vp.height) / vp.width);

// ------------------------------------------------------------------ pointer / wheel / key translation

export interface ModifierState {
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
}
/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export const modifiersOf = (e: ModifierState): number =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

export const buttonName = (button: number): "left" | "middle" | "right" =>
  button === 1 ? "middle" : button === 2 ? "right" : "left";
/** DOM `buttons` bitmask (1 left, 2 right, 4 middle) is CDP's too. */
export const buttonsMask = (buttons: number): number => buttons & 31;

/** Wheel deltas in pixels: line-mode deltas (a mouse wheel in Firefox) are scaled; one gesture never scrolls a screenful in one message. */
export function wheelDeltas(e: { deltaX: number; deltaY: number; deltaMode: number }): {
  deltaX: number;
  deltaY: number;
} {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 600 : 1;
  const cap = (n: number) => clamp(Math.round(n * k), -1600, 1600);
  return { deltaX: cap(e.deltaX), deltaY: cap(e.deltaY) };
}

export interface KeyLike extends ModifierState {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly repeat?: boolean;
}

const FORWARDED_CHORDS = new Set(["a", "c", "x", "z", "y"]);
/** Keys the page must see as non-printing (CDP wants `rawKeyDown` and no text for them). */
const SPECIAL_ENTER = "\r";

/**
 * A keydown as the CDP messages that reproduce it. A printable key becomes keyDown WITH text; Enter carries "\r"; a
 * command/control chord (Cmd+A, Ctrl+C...) is a rawKeyDown without text so the page treats it as a shortcut. Paste
 * (Cmd/Ctrl+V) is NOT forwarded as keys at all - the browser's own `paste` event carries the text (see `isPasteChord`).
 */
export function keyDownMessage(e: KeyLike): ClientMessage | null {
  if (e.key === "Dead" || e.key === "Process" || e.key === "Unidentified") return null;
  if (
    e.key === "Meta" ||
    e.key === "Control" ||
    e.key === "Alt" ||
    e.key === "Shift" ||
    e.key === "CapsLock"
  )
    return null;
  if (isPasteChord(e)) return null;
  const chord = e.ctrlKey || e.metaKey;
  // Cmd/Ctrl chords belong to the app (reload, close, quit, switch window) except the editing ones the remote page needs.
  if (chord && !FORWARDED_CHORDS.has(e.key.toLowerCase())) return null;
  const printable = e.key.length === 1 && !chord && !e.altKey;
  const text = printable ? e.key : e.key === "Enter" ? SPECIAL_ENTER : undefined;
  return {
    t: "key",
    type: text !== undefined ? "keyDown" : "rawKeyDown",
    key: e.key.slice(0, 32),
    code: e.code.slice(0, 32),
    ...(text !== undefined ? { text } : {}),
    vk: clamp(Math.trunc(e.keyCode) || 0, 0, 255),
    modifiers: modifiersOf(e),
  };
}
export function keyUpMessage(e: KeyLike): ClientMessage | null {
  if (e.key === "Dead" || e.key === "Process" || e.key === "Unidentified") return null;
  if (
    e.key === "Meta" ||
    e.key === "Control" ||
    e.key === "Alt" ||
    e.key === "Shift" ||
    e.key === "CapsLock"
  )
    return null;
  if (isPasteChord(e)) return null;
  if ((e.ctrlKey || e.metaKey) && !FORWARDED_CHORDS.has(e.key.toLowerCase())) return null;
  return {
    t: "key",
    type: "keyUp",
    key: e.key.slice(0, 32),
    code: e.code.slice(0, 32),
    vk: clamp(Math.trunc(e.keyCode) || 0, 0, 255),
    modifiers: modifiersOf(e),
  };
}
export const isPasteChord = (e: KeyLike): boolean =>
  (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "v";

/** Pasted text, bounded; the daemon refuses more than 20 000 characters. */
export function pasteMessage(text: string): ClientMessage | null {
  const t = text.replace(/\r\n?/g, "\n");
  return t.length > 0 ? { t: "text", text: t.slice(0, 20_000) } : null;
}

// ------------------------------------------------------------------ approvals, in words

export interface ApprovalWords {
  /** What the blob is about to do, as a short sentence. */
  readonly title: string;
  /** One more line that makes the risk concrete, when we know it. */
  readonly detail: string | null;
}

/**
 * The daemon words an approval for logs and for the blobs approvals card: `click "Book 2 seats" (form POST
 * http://x/book) on x`. The panel says the same thing for a person. Anything it does not recognise is shown as sent.
 */
export function humanizeApproval(summary: string): ApprovalWords {
  const s = summary.trim();
  const click =
    /^(click|press Enter to submit) "(.*?)"(?: \(form (\w+) (\S+?)\))?(?: on .+)?$/s.exec(s);
  if (click) {
    const [, how, label, method, action] = click;
    let path = "";
    try {
      path = action ? new URL(action).pathname : "";
    } catch {
      path = action ?? "";
    }
    const title =
      how === "click" ? `Click \u201c${label}\u201d` : `Submit the form (\u201c${label}\u201d)`;
    const detail =
      method && method.toLowerCase() !== "get"
        ? `This sends what's in the form${path ? ` to ${path}` : ""} (${method.toUpperCase()}).`
        : null;
    return { title, detail };
  }
  const net =
    /^Send data \((\w+) ([^)]*)\)(?: to another site \(([^)]*)\))?(?:, triggered by the agent's (\w+))?(?:: (.*))?$/s.exec(
      s,
    );
  if (net) {
    const [, method, where, other, , why] = net;
    return {
      title: other ? `Send data to ${other}` : "Send data from the page",
      detail: why
        ? `${why[0]!.toUpperCase()}${why.slice(1)} (${method} ${where}).`
        : `${method} ${where}`,
    };
  }
  return { title: s.length > 160 ? `${s.slice(0, 159)}\u2026` : s, detail: null };
}

// ------------------------------------------------------------------ formatting

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${Math.round(n / (1024 * 1024))} MB`;
}

/** "98 MB" for the setup button: the daemon reports bytes; rounded the way people say it. */
export const downloadSizeLabel = (e: EngineInfo | null): string =>
  e?.downloadBytes ? formatBytes(e.downloadBytes) : "about 100 MB";

export function installLabel(i: InstallState): string {
  switch (i.state) {
    case "error":
      return i.message ? i.message : "Something went wrong while setting up.";
    case "done":
      return "Ready";
    default:
      switch (i.phase) {
        case "download":
          return i.total > 0
            ? `Downloading ${formatBytes(i.received)} of ${formatBytes(i.total)}`
            : "Starting the download";
        case "verify":
          return "Checking the download";
        case "extract":
          return "Unpacking";
        case "warm":
          return "Getting it ready";
        default:
          return "Finishing";
      }
  }
}

/** `https://www.cinema.example/showtimes?day=2` -> { secure, host: "cinema.example", rest: "/showtimes?day=2" } for the address pill. */
export function prettyUrl(raw: string): { secure: boolean; host: string; rest: string } | null {
  if (!raw || raw === "about:blank") return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:")
      return { secure: false, host: raw.slice(0, 60), rest: "" };
    const rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}`;
    return {
      secure: u.protocol === "https:",
      host: u.host.replace(/^www\./, ""),
      rest: rest.length > 60 ? `${rest.slice(0, 59)}…` : rest,
    };
  } catch {
    return { secure: false, host: raw.slice(0, 60), rest: "" };
  }
}
export const hostOf = (raw: string): string => prettyUrl(raw)?.host ?? "";

export function tabLabel(t: WireTab): string {
  const title = t.title.trim();
  if (title) return title.length > 28 ? `${title.slice(0, 27)}…` : title;
  return hostOf(t.url) || "New tab";
}
