import {
  type ServerMessage,
  type BrowserState,
  wheelDeltas,
  tabLabel,
  prettyUrl,
  pasteMessage,
  parseServerMessage,
  modifiersOf,
  mapPointerClamped,
  mapPointer,
  keyUpMessage,
  keyDownMessage,
  isPasteChord,
  isEmptyPage,
  installLabel,
  initialBrowserState,
  heightForWidth,
  handBackRemaining,
  formatBytes,
  downloadSizeLabel,
  WORK_HOLD_MS,
  deriveStatus,
  countdownSeconds,
  containFit,
  buttonName,
  browserReducer,
} from "./browserModel";
import { describe, expect, it } from "vite-plus/test";

const VP = { width: 1280, height: 800 };
const hello = (
  over: Partial<Extract<ServerMessage, { t: "hello" | "state" }>> = {},
): ServerMessage => ({
  t: "hello",
  running: true,
  working: false,
  tool: null,
  controller: "agent",
  idleMs: 0,
  releaseAfterMs: 8000,
  youControl: false,
  tabs: [{ index: 0, title: "Rialto", url: "http://cinema.example/", active: true }],
  approvals: [],
  viewport: VP,
  ...over,
});
const apply = (s: BrowserState, ...ms: ServerMessage[]) =>
  ms.reduce((acc, m) => browserReducer(acc, { type: "message", message: m }), s);
const open = (s: BrowserState = initialBrowserState) =>
  browserReducer(s, { type: "connection", connection: "open" });

describe("approvals in words", () => {
  it("anything else is shown as it came, bounded", async () => {
    const { humanizeApproval } = await import("./browserModel");
    expect(humanizeApproval("something new")).toEqual({ title: "something new", detail: null });
    expect(humanizeApproval("x".repeat(400)).title).toHaveLength(160);
  });
  it("the network backstop's sentence keeps its reason", async () => {
    const { humanizeApproval } = await import("./browserModel");
    const w = humanizeApproval(
      "Send data (POST pay.stripe.com/v1/charges) to another site (pay.stripe.com): looks like a checkout / payment / account request",
    );
    expect(w.title).toBe("Send data to pay.stripe.com");
    expect(w.detail).toBe(
      "Looks like a checkout / payment / account request (POST pay.stripe.com/v1/charges).",
    );
    expect(
      humanizeApproval(
        "Send data (POST x.example/api/book), triggered by the agent's browser_click",
      ).title,
    ).toBe("Send data from the page");
  });
  it("a form submit says what it will click and where the form goes", async () => {
    const { humanizeApproval } = await import("./browserModel");
    expect(
      humanizeApproval(
        'click "Book 2 seats · $28" (form POST http://127.0.0.1:65082/book) on 127.0.0.1:65082',
      ),
    ).toEqual({
      detail: "This sends what's in the form to /book (POST).",
      title: "Click “Book 2 seats · $28”",
    });
    expect(humanizeApproval('click "Search" (form GET http://x/search) on x').detail).toBeNull();
    expect(humanizeApproval('click "Delete account" on cinema.example')).toEqual({
      detail: null,
      title: "Click “Delete account”",
    });
    expect(
      humanizeApproval('press Enter to submit "Enter in email" (form POST http://x/order) on x')
        .title,
    ).toBe("Submit the form (“Enter in email”)");
  });
});

describe("formatting", () => {
  it("address pill and tab labels", () => {
    expect(prettyUrl("https://www.cinema.example/showtimes?day=2")).toEqual({
      rest: "/showtimes?day=2",
      host: "cinema.example",
      secure: true,
    });
    expect(prettyUrl("http://127.0.0.1:4000/")).toEqual({
      rest: "",
      host: "127.0.0.1:4000",
      secure: false,
    });
    expect(prettyUrl("about:blank")).toBeNull();
    expect(prettyUrl("")).toBeNull();
    expect(prettyUrl("https://x.example/" + "a".repeat(200))!.rest.endsWith("…")).toBe(true);
    expect(
      tabLabel({ index: 0, title: "  ", url: "https://www.cinema.example/", active: true }),
    ).toBe("cinema.example");
    expect(tabLabel({ index: 0, title: "A".repeat(50), url: "", active: true })).toHaveLength(28);
    expect(tabLabel({ index: 0, title: "", url: "", active: true })).toBe("New tab");
  });

  it("install labels per phase", () => {
    const i = (o: Partial<Parameters<typeof installLabel>[0]>) =>
      installLabel({
        state: "running",
        phase: "download",
        received: 0,
        total: 0,
        fraction: 0,
        message: null,
        ...o,
      });
    expect(i({})).toBe("Starting the download");
    expect(i({ received: 50 * 1048576, total: 98 * 1048576 })).toBe("Downloading 50 MB of 98 MB");
    expect(i({ phase: "verify" })).toBe("Checking the download");
    expect(i({ phase: "extract" })).toBe("Unpacking");
    expect(i({ phase: "warm" })).toBe("Getting it ready");
    expect(i({ state: "error", message: "engine download failed: HTTP 503" })).toBe(
      "engine download failed: HTTP 503",
    );
    expect(i({ state: "done" })).toBe("Ready");
  });
  it("the download size reads the way people say it", () => {
    expect(formatBytes(102_429_510)).toBe("98 MB");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(10)).toBe("1 KB");
    expect(formatBytes(null)).toBe("");
    expect(
      downloadSizeLabel({
        downloadBytes: 102_429_510,
        version: null,
        installed: false,
        supported: true,
      }),
    ).toBe("98 MB");
    expect(downloadSizeLabel(null)).toBe("about 100 MB");
  });
});

describe("status shown to the person", () => {
  const base = (over: Partial<BrowserState> = {}): BrowserState => ({
    ...open(apply(open(), hello())),
    ...over,
  });

  it("empty page: nothing open, or only about:blank", () => {
    expect(
      isEmptyPage(
        base({ tabs: [{ index: 0, title: "", url: "about:blank", active: true }], hasFrame: true }),
      ),
    ).toBe(true);
    expect(isEmptyPage(base({ tabs: [], hasFrame: true }))).toBe(true);
    expect(isEmptyPage(base({ hasFrame: true }))).toBe(false);
    expect(isEmptyPage(base({ running: false, hasFrame: false }))).toBe(true);
    expect(isEmptyPage(base({ running: false, hasFrame: true }))).toBe(false);
  });

  it("an unknown tool still reads as 'Working'", () => {
    expect(deriveStatus(base({ working: true, tool: "browser_future" })).detail).toBe("Working");
  });

  it("needs-you outranks working and closed; an approval is never hidden by a busy browser", () => {
    expect(
      deriveStatus(base({ working: true, approvals: [{ id: "a", summary: "x", url: "" }] })).status,
    ).toBe("needs-you");
  });

  it("idle, working, needs you, driving, closed, offline, setup", () => {
    expect(deriveStatus(base()).status).toBe("idle");
    expect(deriveStatus(base({ working: true, tool: "browser_click" }))).toMatchObject({
      detail: "Clicking",
      status: "working",
    });
    expect(deriveStatus(base({ approvals: [{ id: "a", summary: "x", url: "" }] }))).toMatchObject({
      label: "Needs you",
      status: "needs-you",
    });
    expect(deriveStatus(base({ controller: "user", youControl: true }))).toMatchObject({
      label: "You're driving",
      status: "driving",
    });
    expect(deriveStatus(base({ running: false }))).toMatchObject({ status: "closed" });
    expect(deriveStatus(base({ connection: "reconnecting" })).status).toBe("offline");
    expect(deriveStatus(base({ connection: "unavailable" })).status).toBe("offline");
    expect(
      deriveStatus(
        base({ engine: { supported: true, installed: false, version: null, downloadBytes: 1 } }),
      ).status,
    ).toBe("setup");
  });

  it("keeps reading Working in the gap between two browser calls, then goes Idle", () => {
    const during = apply(
      open(),
      hello({ working: true, tool: "browser_click" }),
      hello({ t: "state", working: false, tool: null }),
    );
    const t0 = during.workedUntil - WORK_HOLD_MS;
    expect(deriveStatus(during, t0 + 1000)).toMatchObject({
      detail: "Clicking",
      status: "working",
    });
    expect(deriveStatus(during, t0 + WORK_HOLD_MS + 1000).status).toBe("idle");
    // a browser nobody has used is not "Working"
    expect(deriveStatus(apply(open(), hello()), Date.now()).status).toBe("idle");
  });
});

describe("daemon messages", () => {
  it("parses server text and drops junk", () => {
    expect(parseServerMessage('{"t":"pong","ts":1}')).toEqual({ t: "pong", ts: 1 });
    expect(parseServerMessage("nope")).toBeNull();
    expect(parseServerMessage('{"x":1}')).toBeNull();
    expect(parseServerMessage("null")).toBeNull();
  });

  it("a bad viewport never replaces a good one", () => {
    const s = apply(open(), hello({ viewport: { width: 0, height: 0 } }));
    expect(s.viewport).toEqual(VP);
  });

  it("a state that says the agent has the browser clears the 'another window' notice", () => {
    let s = apply(open(), hello({ controller: "user", youControl: false }), {
      message: "Another Kora window is driving this browser.",
      t: "busy",
    });
    expect(s.busyNotice).toMatch(/Another/);
    s = apply(s, hello({ controller: "agent" }));
    expect(s.busyNotice).toBeNull();
  });
  it("hello fills the state; engine and install messages track the setup", () => {
    let s = open();
    s = apply(
      s,
      hello({
        tool: "browser_click",
        working: true,
        approvals: [{ id: "a1", summary: "Place order", url: "http://cinema.example/seats" }],
      }),
    );
    expect(s.running).toBe(true);
    expect(s.approvals).toHaveLength(1);
    expect(s.viewport).toEqual(VP);
    s = apply(s, {
      downloadBytes: 102_429_510,
      version: null,
      installed: false,
      supported: true,
      t: "engine",
    });
    expect(s.engine?.installed).toBe(false);
    s = apply(s, {
      fraction: 0.1,
      total: 100,
      received: 10,
      phase: "download",
      state: "running",
      t: "install",
    });
    expect(s.install).toMatchObject({ state: "running", fraction: 0.1 });
    s = apply(s, {
      message: "engine download failed: HTTP 503",
      fraction: 0,
      total: 0,
      received: 0,
      phase: "error",
      state: "error",
      t: "install",
    });
    expect(s.install).toMatchObject({
      message: "engine download failed: HTTP 503",
      state: "error",
    });
    s = apply(s, {
      downloadBytes: 1,
      version: "155",
      installed: true,
      supported: true,
      t: "engine",
    });
    expect(s.engine?.installed).toBe(true);
  });
});

describe("take-over countdown", () => {
  it("counts down from the last input and clamps at zero; nothing when the user is not driving", () => {
    expect(
      handBackRemaining({ driving: false, lastInputAt: 0, releaseAfterMs: 8000, now: 10 }),
    ).toBeNull();
    expect(
      handBackRemaining({ driving: true, lastInputAt: 1000, releaseAfterMs: 8000, now: 1000 }),
    ).toBe(8000);
    expect(
      handBackRemaining({ driving: true, lastInputAt: 1000, releaseAfterMs: 8000, now: 5500 }),
    ).toBe(3500);
    expect(
      handBackRemaining({ driving: true, lastInputAt: 1000, releaseAfterMs: 8000, now: 99999 }),
    ).toBe(0);
    expect(countdownSeconds(3500)).toBe(4);
    expect(countdownSeconds(0)).toBe(1);
    expect(countdownSeconds(1000)).toBe(1);
  });
});

describe("keyboard, wheel and paste", () => {
  const key = (over: Record<string, unknown>) =>
    ({
      key: "a",
      code: "KeyA",
      keyCode: 65,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...over,
    }) as never;

  it("paste text is normalised and bounded; empty paste is nothing", () => {
    expect(pasteMessage("a\r\nb")).toEqual({ t: "text", text: "a\nb" });
    expect(pasteMessage("")).toBeNull();
    expect((pasteMessage("x".repeat(30_000)) as { text: string }).text).toHaveLength(20_000);
  });

  it("buttons and wheel", () => {
    expect([0, 1, 2].map(buttonName)).toEqual(["left", "middle", "right"]);
    expect(wheelDeltas({ deltaX: 0, deltaY: 120, deltaMode: 0 })).toEqual({
      deltaY: 120,
      deltaX: 0,
    });
    expect(wheelDeltas({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toEqual({ deltaX: 0, deltaY: 48 });
    expect(wheelDeltas({ deltaX: 0, deltaY: 99999, deltaMode: 0 }).deltaY).toBe(1600);
    expect(wheelDeltas({ deltaX: -99999, deltaY: 0.4, deltaMode: 0 })).toEqual({
      deltaY: 0,
      deltaX: -1600,
    });
  });

  it("modifier bits follow CDP: alt 1, ctrl 2, meta 4, shift 8", () => {
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(modifiersOf({ altKey: false, ctrlKey: false, metaKey: true, shiftKey: false })).toBe(4);
  });

  it("editing chords go to the page; paste goes through the paste event; app chords stay with the app", () => {
    expect(keyDownMessage(key({ key: "a", metaKey: true }))).toMatchObject({
      modifiers: 4,
      type: "rawKeyDown",
    });
    expect(keyDownMessage(key({ key: "z", ctrlKey: true }))).toMatchObject({
      modifiers: 2,
      type: "rawKeyDown",
    });
    expect(keyDownMessage(key({ key: "v", metaKey: true }))).toBeNull();
    expect(isPasteChord(key({ key: "V", ctrlKey: true }))).toBe(true);
    expect(isPasteChord(key({ key: "v" }))).toBe(false);
    for (const k of ["r", "w", "q", "t", "n", ","]) {
      expect(keyDownMessage(key({ key: k, metaKey: true }))).toBeNull();
      expect(keyUpMessage(key({ key: k, metaKey: true }))).toBeNull();
    }
    expect(keyDownMessage(key({ key: "é", altKey: true }))).toMatchObject({ type: "rawKeyDown" });
  });

  it("modifier keys on their own, dead keys and IME events are not forwarded", () => {
    for (const k of [
      "Shift",
      "Control",
      "Alt",
      "Meta",
      "CapsLock",
      "Dead",
      "Process",
      "Unidentified",
    ]) {
      expect(keyDownMessage(key({ key: k }))).toBeNull();
      expect(keyUpMessage(key({ key: k }))).toBeNull();
    }
  });

  it("a printable key carries its text; Enter carries a carriage return; arrows are raw", () => {
    expect(keyDownMessage(key({}))).toEqual({
      modifiers: 0,
      vk: 65,
      text: "a",
      code: "KeyA",
      key: "a",
      type: "keyDown",
      t: "key",
    });
    expect(keyDownMessage(key({ key: "A", shiftKey: true }))).toMatchObject({
      modifiers: 8,
      text: "A",
    });
    expect(keyDownMessage(key({ key: "Enter", code: "Enter", keyCode: 13 }))).toMatchObject({
      text: "\r",
      type: "keyDown",
    });
    expect(keyDownMessage(key({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 }))).toEqual({
      modifiers: 0,
      vk: 37,
      code: "ArrowLeft",
      key: "ArrowLeft",
      type: "rawKeyDown",
      t: "key",
    });
    expect(keyDownMessage(key({ key: "Tab", code: "Tab", keyCode: 9 }))).toMatchObject({
      type: "rawKeyDown",
    });
    expect(keyUpMessage(key({ key: "Enter", code: "Enter", keyCode: 13 }))).toEqual({
      modifiers: 0,
      vk: 13,
      code: "Enter",
      key: "Enter",
      type: "keyUp",
      t: "key",
    });
  });
});

describe("pointer mapping (the remote page's CSS pixels)", () => {
  const rect = { left: 100, top: 50, width: 640, height: 400 };
  it("sizes a box for the page's aspect ratio", () => {
    expect(heightForWidth(356, VP)).toBe(223);
    expect(heightForWidth(1280, VP)).toBe(800);
  });

  it("refuses a zero-sized box instead of dividing by it", () => {
    expect(mapPointer(5, 5, { left: 0, top: 0, width: 0, height: 0 }, VP)).toBeNull();
    expect(mapPointerClamped(5, 5, { left: 0, top: 0, width: 0, height: 0 }, VP)).toEqual({
      y: 0,
      x: 0,
    });
    expect(mapPointer(5, 5, rect, { width: 0, height: 0 })).toBeNull();
  });

  it("a drag that leaves the picture keeps tracking at the edge", () => {
    expect(mapPointerClamped(-500, -500, rect, VP)).toEqual({ x: 0, y: 0 });
    expect(mapPointerClamped(5000, 5000, rect, VP)).toEqual({ x: 1279, y: 799 });
    const wide = { left: 0, top: 0, width: 1600, height: 800 };
    expect(mapPointerClamped(10, 400, wide, VP)).toEqual({ x: 0, y: 400 });
  });

  it("letterboxes an expanded view that is wider than the page: the bars are not the page", () => {
    const wide = { left: 0, top: 0, width: 1600, height: 800 }; // page fits 1280x800 centred, 160px bars
    expect(containFit(wide, VP)).toEqual({
      scale: 1,
      offsetY: 0,
      offsetX: 160,
      height: 800,
      width: 1280,
    });
    expect(mapPointer(100, 400, wide, VP)).toBeNull();
    expect(mapPointer(1500, 400, wide, VP)).toBeNull();
    expect(mapPointer(160, 0, wide, VP)).toEqual({ x: 0, y: 0 });
    expect(mapPointer(800, 400, wide, VP)).toEqual({ x: 640, y: 400 });
    const tall = { left: 0, top: 0, width: 640, height: 900 }; // bars above and below
    const fit = containFit(tall, VP);
    expect(fit.width).toBe(640);
    expect(fit.height).toBe(400);
    expect(fit.offsetY).toBe(250);
    expect(mapPointer(320, 100, tall, VP)).toBeNull();
    expect(mapPointer(320, 450, tall, VP)).toEqual({ x: 640, y: 400 });
  });

  it("handles the panel at its real width (not a round multiple of the viewport)", () => {
    const narrow = { left: 12.5, top: 90.25, width: 356, height: 222.5 };
    const p = mapPointer(narrow.left + 178, narrow.top + 111.25, narrow, VP)!;
    expect(p.x).toBeCloseTo(640, 6);
    expect(p.y).toBeCloseTo(400, 6);
    const corner = mapPointer(
      narrow.left + narrow.width - 0.1,
      narrow.top + narrow.height - 0.1,
      narrow,
      VP,
    )!;
    expect(corner.x).toBeLessThanOrEqual(1279);
    expect(corner.y).toBeLessThanOrEqual(799);
  });

  it("is independent of the device pixel ratio and the canvas backing size", () => {
    // A retina canvas has width=2560 in the DOM but a 640px CSS box; event coordinates and the rect are CSS pixels.
    for (const dpr of [1, 1.25, 2, 3]) {
      const cssRect = { left: 10 / dpr, top: 20 / dpr, width: 640, height: 400 }; // any fractional offset
      const p = mapPointer(cssRect.left + 320, cssRect.top + 200, cssRect, VP)!;
      expect(p.x).toBeCloseTo(640, 6);
      expect(p.y).toBeCloseTo(400, 6);
    }
  }); // the 1280x800 page at half size

  it("maps a point inside the picture and ignores where the box sits on the screen", () => {
    expect(mapPointer(100, 50, rect, VP)).toEqual({ x: 0, y: 0 });
    expect(mapPointer(420, 250, rect, VP)).toEqual({ x: 640, y: 400 });
    expect(mapPointer(739, 449, rect, VP)).toEqual({ x: 1278, y: 798 });
  });
});
