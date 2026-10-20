import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { cloneElement } from "react";

vi.mock("~/components/ui/button", () => ({
  Button: ({
    children,
    size: _s,
    variant: _v,
    ...rest
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => <button {...rest}>{children}</button>,
}));
vi.mock("~/components/ui/spinner", () => ({ Spinner: () => <i data-spinner /> }));
vi.mock("~/components/ui/tooltip", () => ({
  TooltipPopup: () => null,
  TooltipTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode;
    render?: React.ReactElement<Record<string, unknown>>;
  }) => (render ? cloneElement(render, undefined, children) : <>{children}</>),
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import { initialBrowserState, type ServerMessage } from "./browserModel";
import {
  type EngineSnapshot,
  type EngineApi,
  parseEngineSnapshot,
  EngineApiProvider,
} from "./useBrowserEngine";
import { LiveConnectorProvider, type LiveConnector, type LiveHandlers } from "./liveConnection";
import { ApprovalBar, TakeoverBanner } from "./parts";
import { InstallScreen } from "./InstallScreen";

import { BrowserPanel } from "./BrowserPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ------------------------------------------------------------------ a fake daemon connection

interface Fake {
  handlers: LiveHandlers | null;
  sent: Array<Record<string, unknown>>;
  closed: boolean;
  blobId: string | null;
}
function fakeConnector(): { connector: LiveConnector; fake: Fake; push(m: object): void } {
  const fake: Fake = { handlers: null, sent: [], closed: false, blobId: null };
  const connector: LiveConnector = (blobId, handlers) => {
    fake.handlers = handlers;
    fake.blobId = blobId;
    return {
      send: (raw) => fake.sent.push(JSON.parse(raw)),
      close: () => {
        fake.closed = true;
      },
      get isOpen() {
        return !fake.closed;
      },
    };
  };
  return { connector, fake, push: (m: object) => fake.handlers?.onText(JSON.stringify(m)) };
}

const state = (over: Record<string, unknown> = {}): ServerMessage =>
  ({
    t: "state",
    running: true,
    working: false,
    tool: null,
    controller: "agent",
    idleMs: 0,
    releaseAfterMs: 8000,
    youControl: false,
    tabs: [
      { index: 0, title: "Rialto Cinema", url: "https://cinema.example/showtimes", active: true },
    ],
    approvals: [],
    viewport: { width: 1280, height: 800 },
    ...over,
  }) as ServerMessage;
const engine = (installed: boolean) => ({
  downloadBytes: 102_429_510,
  version: installed ? "155" : null,
  installed,
  supported: true,
  t: "engine",
});

const text = (r: ReactTestRenderer) => JSON.stringify(r.toJSON());
const find = (r: ReactTestRenderer | ReactTestInstance, pred: (i: ReactTestInstance) => boolean) =>
  (("root" in r ? r.root : r) as ReactTestInstance).findAll(pred);
const byAttr = (r: ReactTestRenderer, attr: string) =>
  find(r, (i) => typeof i.type === "string" && attr in i.props);
const visibleText = (r: ReactTestRenderer) => {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (typeof n === "string") out.push(n);
    else if (n && typeof n === "object")
      for (const c of (n as { children?: unknown[] }).children ?? []) walk(c);
  };
  walk(r.toJSON());
  return out.join(" ").replace(/\s+/g, " ");
};

const canvasMock = (rect = { left: 100, top: 50, width: 640, height: 400 }) => ({
  releasePointerCapture: vi.fn(),
  setPointerCapture: vi.fn(),
  focus: vi.fn(),
  removeEventListener: vi.fn(),
  addEventListener: vi.fn(),
  getContext: () => ({ drawImage: vi.fn() }),
  getBoundingClientRect: () => ({
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
  }),
  height: 800,
  width: 1280,
});

let renderer: ReactTestRenderer | null = null;
// The engine API over plain HTTP, faked: tests set `engineNow` and read `engineCalls`.
const IDLE = {
  message: null,
  fraction: 0,
  total: 0,
  received: 0,
  phase: "download",
  state: "idle",
} as const;
const snap = (
  installed: boolean,
  install: Partial<EngineSnapshot["install"]> = {},
): EngineSnapshot => ({
  install: { ...IDLE, ...install },
  downloadBytes: 102_429_510,
  version: installed ? "155" : null,
  installed,
  supported: true,
});
let engineNow: EngineSnapshot | Error = snap(true);
const engineCalls: string[] = [];
const engineApi: EngineApi = {
  install: async () => {
    engineCalls.push("install");
    if (engineNow instanceof Error) throw engineNow;
    engineNow = {
      ...engineNow,
      install: {
        ...engineNow.install,
        state: "running",
        phase: "download",
        total: 102_429_510,
        received: 1_000_000,
        fraction: 0.01,
      },
    };
    return engineNow;
  },
  status: async () => {
    engineCalls.push("status");
    if (engineNow instanceof Error) throw engineNow;
    return engineNow;
  },
};

async function mount(
  connector: LiveConnector,
  rect?: { left: number; top: number; width: number; height: number },
) {
  await act(async () => {
    renderer = create(
      <EngineApiProvider api={engineApi}>
        <LiveConnectorProvider connector={connector}>
          <BrowserPanel blobId="blob_popo" blobName="Popo" />
        </LiveConnectorProvider>
      </EngineApiProvider>,
      { createNodeMock: (el) => (el.type === "canvas" ? canvasMock(rect) : null) },
    );
  });
  return renderer!;
}
const open = async (h: Fake) => act(async () => h.handlers?.onOpen());
const feed = async (push: (m: object) => void, ...ms: object[]) =>
  act(async () => ms.forEach(push));

const render = (el: React.ReactElement) => {
  let r!: ReactTestRenderer;
  act(() => {
    r = create(el);
  });
  return r;
};

beforeEach(() => {
  engineNow = snap(true);
  engineCalls.length = 0;
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: () => void) =>
    setTimeout(cb, 16) as unknown as number;
  (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = (id: number) =>
    clearTimeout(id);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
});

/** Keyboard/pointer modifier flags with nothing held. */
const MODS_UP = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };

describe("parseEngineSnapshot", () => {
  it("reads the endpoint's JSON defensively", () => {
    expect(parseEngineSnapshot(null)).toBeNull();
    expect(parseEngineSnapshot({ installed: "yes" })).toBeNull();
    const s = parseEngineSnapshot({
      install: {
        message: null,
        fraction: 0.5,
        total: 2,
        received: 1,
        phase: "extract",
        state: "running",
      },
      downloadBytes: 5,
      version: null,
      installed: false,
      supported: true,
    });
    expect(s).toMatchObject({
      install: { state: "running", phase: "extract", fraction: 0.5 },
      downloadBytes: 5,
      installed: false,
    });
    expect(
      parseEngineSnapshot({
        install: { state: "weird", phase: "??" },
        installed: true,
        supported: true,
      })!.install,
    ).toMatchObject({ state: "idle", phase: "download" });
  });
});

describe("setup over plain HTTP (no live socket needed)", () => {
  it("when the daemon cannot say (older build), the socket's own engine frame still decides", async () => {
    engineNow = new Error("engine status 404");
    const { connector, fake, push } = fakeConnector();
    const r = await mount(connector);
    await open(fake);
    await feed(push, state({ running: false, tabs: [] }), engine(false));
    expect(visibleText(r)).toContain("Give blobs a browser");
  });

  it("a failed install says why and offers Try again", async () => {
    engineNow = snap(false, {
      message: "engine download failed: HTTP 503",
      phase: "error",
      state: "error",
    });
    const { connector } = fakeConnector();
    const r = await mount(connector);
    expect(visibleText(r)).toContain("Setup didn't finish");
    expect(visibleText(r)).toContain("HTTP 503");
    expect(visibleText(r)).toContain("Try again");
  });

  it("Set up starts the install over HTTP and polls its progress until the engine is there, then connects the view", async () => {
    engineNow = snap(false);
    const { connector, fake } = fakeConnector();
    const r = await mount(connector);
    await act(async () => byAttr(r, "data-browser-install-button")[0]!.props.onClick());
    expect(engineCalls.filter((c) => c === "install")).toHaveLength(1);
    expect(visibleText(r)).toContain("Setting up the blob browser");
    // the daemon reports more progress
    engineNow = snap(false, {
      fraction: 0.5,
      received: 51_214_755,
      total: 102_429_510,
      phase: "download",
      state: "running",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(find(r, (i) => i.props.role === "progressbar")[0]!.props["aria-valuenow"]).toBe(50);
    // done: the screen goes away and the live view reconnects
    const connectsBefore = fake.blobId;
    engineNow = snap(true, { state: "done", phase: "done", fraction: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(byAttr(r, "data-browser-install")).toHaveLength(0);
    expect(connectsBefore).toBe("blob_popo");
    expect(fake.closed).toBe(true); // the old (never opened) connection was replaced by a fresh one
  });
  it("a browser that was never installed shows the setup screen even though the live socket never opens", async () => {
    engineNow = snap(false);
    const { connector } = fakeConnector();
    const r = await mount(connector);
    // the socket is still "connecting": no onOpen
    expect(engineCalls).toContain("status");
    expect(visibleText(r)).toContain("Give blobs a browser");
    expect(visibleText(r)).toContain("Set up (98 MB)");
    expect(visibleText(r)).not.toContain("Connecting");
  });
});

describe("approvals", () => {
  const approval = {
    url: "http://127.0.0.1:4000/seats",
    summary: 'click "Book 2 seats" (form POST http://127.0.0.1:4000/book) on 127.0.0.1:4000',
    id: "ab12",
  };

  it("renders alone with no page host when the url is unknown", () => {
    const r = render(
      <ApprovalBar
        name="Popo"
        approval={{ id: "a", summary: "Send data", url: "" }}
        more={0}
        answered={false}
        onAnswer={() => {}}
      />,
    );
    expect(byAttr(r, "data-browser-approval-where")).toHaveLength(0);
    expect(visibleText(r)).toContain("Allow once");
    expect(visibleText(r)).toContain("Deny");
  });

  it("asks what and where, answers Allow once / Deny to the daemon, and locks the buttons until the daemon moves on", async () => {
    const { connector, fake, push } = fakeConnector();
    const r = await mount(connector);
    await open(fake);
    await feed(
      push,
      engine(true),
      state({ approvals: [approval, { id: "zz", summary: "second", url: "http://x/" }] }),
    );
    expect(visibleText(r)).toContain("Popo needs your OK");
    expect(byAttr(r, "data-browser-approval-what")[0]!.children.join("")).toContain("Book 2 seats");
    expect(visibleText(r)).toContain("On 127.0.0.1:4000");
    expect(visibleText(r)).toContain("1 more waiting after this one");
    expect(byAttr(r, "data-browser-status")[0]!.props["data-browser-status"]).toBe("needs-you");
    const deny = byAttr(r, "data-browser-deny")[0]!;
    await act(async () => deny.props.onClick());
    expect(fake.sent.at(-1)).toEqual({ t: "approve", id: "ab12", allow: false });
    expect(byAttr(r, "data-browser-deny")[0]!.props.disabled).toBe(true);
    expect(byAttr(r, "data-browser-allow")[0]!.props.disabled).toBe(true);
    // the daemon settled it: the next one is asked (buttons live again)
    await feed(push, state({ approvals: [{ id: "zz", summary: "second", url: "http://x/" }] }));
    expect(byAttr(r, "data-browser-allow")[0]!.props.disabled).toBe(false);
    await act(async () => byAttr(r, "data-browser-allow")[0]!.props.onClick());
    expect(fake.sent.at(-1)).toEqual({ t: "approve", id: "zz", allow: true });
  });
});

describe("input from the picture", () => {
  const prime = async (rect?: { left: number; top: number; width: number; height: number }) => {
    const c = fakeConnector();
    const r = await mount(c.connector, rect);
    await open(c.fake);
    await feed(
      c.push,
      engine(true),
      state({
        tabs: [{ index: 0, title: "Cinema", url: "https://cinema.example/", active: true }],
      }),
    );
    // the first frame arrives (the canvas is mocked: only the "has a picture" bit matters)
    await act(async () => {
      (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
        width: 1280,
        height: 800,
        close() {},
      });
      c.fake.handlers?.onFrame(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
      await vi.advanceTimersByTimeAsync(20);
    });
    const canvas = find(r, (i) => i.type === "canvas")[0]!;
    return { ...c, r, canvas };
  };

  it("while another window drives, nothing is sent", async () => {
    const { fake, canvas, push, r } = await prime();
    await feed(push, state({ controller: "user", youControl: false }));
    const before = fake.sent.length;
    const down = find(r, (i) => i.type === "canvas")[0]!;
    await act(async () =>
      down.props.onPointerDown({
        currentTarget: { focus() {}, setPointerCapture() {} },
        pointerId: 1,
        clientX: 200,
        clientY: 100,
        button: 0,
        buttons: 1,
        detail: 1,
        ...MODS_UP,
        preventDefault() {},
      }),
    );
    await act(async () =>
      canvas.props.onKeyDown({
        nativeEvent: {
          ...MODS_UP,
          keyCode: 65,
          code: "KeyA",
          key: "a",
        },
        preventDefault() {},
      }),
    );
    expect(fake.sent.length).toBe(before);
  });

  it("keys and paste are forwarded; paste chords are not turned into keystrokes; app chords stay with the app", async () => {
    const { fake, canvas } = await prime();
    const key = (over: Record<string, unknown>) => ({
      preventDefault: vi.fn(),
      nativeEvent: {
        key: "a",
        code: "KeyA",
        keyCode: 65,
        ...MODS_UP,
        ...over,
      },
    });
    const k = key({});
    await act(async () => canvas.props.onKeyDown(k));
    expect(k.preventDefault).toHaveBeenCalled();
    expect(fake.sent.at(-1)).toMatchObject({ t: "key", type: "keyDown", key: "a", text: "a" });
    const n = fake.sent.length;
    const cmdR = key({ key: "r", code: "KeyR", metaKey: true });
    await act(async () => canvas.props.onKeyDown(cmdR));
    expect(cmdR.preventDefault).not.toHaveBeenCalled();
    const cmdV = key({ key: "v", metaKey: true });
    await act(async () => canvas.props.onKeyDown(cmdV));
    expect(cmdV.preventDefault).not.toHaveBeenCalled();
    expect(fake.sent.length).toBe(n);
    await act(async () =>
      canvas.props.onPaste({
        preventDefault() {},
        clipboardData: { getData: () => "hello there" },
      }),
    );
    expect(fake.sent.at(-1)).toEqual({ t: "text", text: "hello there" });
  });

  it("hover alone sends nothing while the agent drives; a drag does", async () => {
    const { fake, canvas } = await prime();
    const before = fake.sent.length;
    await act(async () => canvas.props.onPointerMove({ clientX: 200, clientY: 100, buttons: 0 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(fake.sent.length).toBe(before);
    await act(async () => canvas.props.onPointerMove({ clientX: 200, clientY: 100, buttons: 1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(fake.sent.at(-1)).toMatchObject({ t: "mouse", type: "mouseMoved" });
  });

  it("the mapping follows the canvas' real box, whatever the device pixel ratio", async () => {
    const { fake, canvas } = await prime({ left: 12.5, top: 90.25, width: 356, height: 222.5 });
    (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
    await act(async () =>
      canvas.props.onPointerDown({
        currentTarget: { focus() {}, setPointerCapture() {} },
        pointerId: 1,
        clientX: 12.5 + 178,
        clientY: 90.25 + 111.25,
        button: 0,
        buttons: 1,
        detail: 1,
        ...MODS_UP,
        preventDefault() {},
      }),
    );
    const m = fake.sent.at(-1) as { x: number; y: number };
    expect(m.x).toBeCloseTo(640, 4);
    expect(m.y).toBeCloseTo(400, 4);
  });

  it("a click maps to the remote page's pixels and carries button, count and modifiers", async () => {
    const { fake, canvas } = await prime({ left: 100, top: 50, width: 640, height: 400 });
    expect(canvas.props.role).toBe("application");
    await act(async () =>
      canvas.props.onPointerDown({
        currentTarget: { focus() {}, setPointerCapture() {} },
        pointerId: 1,
        clientX: 420,
        clientY: 250,
        button: 0,
        buttons: 1,
        detail: 2,
        ...MODS_UP,
        shiftKey: true,
        preventDefault() {},
      }),
    );
    expect(fake.sent.at(-1)).toEqual({
      modifiers: 8,
      clickCount: 2,
      buttons: 1,
      button: "left",
      y: 400,
      x: 640,
      type: "mousePressed",
      t: "mouse",
    });
    await act(async () =>
      canvas.props.onPointerUp({
        ...MODS_UP,
        detail: 2,
        buttons: 0,
        button: 0,
        clientY: 250,
        clientX: 420,
        pointerId: 1,
        currentTarget: { releasePointerCapture() {} },
      }),
    );
    expect(fake.sent.at(-1)).toMatchObject({ t: "mouse", type: "mouseReleased", x: 640, y: 400 });
  });
});

describe("taking over", () => {
  it("the banner countdown renders its number and its bar", () => {
    const r = render(
      <TakeoverBanner name="Popo" remainingMs={2300} releaseAfterMs={8000} onHandBack={() => {}} />,
    );
    expect(visibleText(r)).toContain("Popo takes it back in 3s");
  });

  it("another window driving: this one only watches and sends no input", async () => {
    const { connector, fake, push } = fakeConnector();
    const r = await mount(connector);
    await open(fake);
    await feed(push, engine(true), state({ controller: "user", youControl: false }));
    expect(byAttr(r, "data-browser-watching")).toHaveLength(1);
    expect(visibleText(r)).toContain("Another Kora window is driving");
    expect(byAttr(r, "data-browser-takeover")).toHaveLength(0);
  });
  it("shows 'You're driving' with a Hand back button that asks the daemon; the countdown appears only near the end", async () => {
    const { connector, fake, push } = fakeConnector();
    const r = await mount(connector);
    await open(fake);
    await feed(push, engine(true), state());
    expect(byAttr(r, "data-browser-takeover")).toHaveLength(0);
    await feed(push, state({ controller: "user", youControl: true }));
    const banner = byAttr(r, "data-browser-takeover")[0]!;
    expect(banner).toBeTruthy();
    expect(visibleText(r)).toContain("You're driving");
    expect(visibleText(r)).toContain("Popo is paused until you hand back");
    expect(byAttr(r, "data-browser-countdown")[0]!.props["data-browser-countdown"]).toBe("off");
    // idle for 4 s of the 8: the countdown shows
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(byAttr(r, "data-browser-countdown")[0]!.props["data-browser-countdown"]).toBe("on");
    expect(visibleText(r)).toMatch(/Popo takes it back in [1-4]s/);
    const hand = find(
      r,
      (i) => i.type === "button" && i.children.some((c) => c === "Hand back"),
    )[0]!;
    await act(async () => hand.props.onClick());
    expect(fake.sent.at(-1)).toEqual({ t: "release" });
    // the daemon says it is handed back: the banner goes
    await feed(push, state({ controller: "agent", youControl: false }));
    expect(byAttr(r, "data-browser-takeover")).toHaveLength(0);
    expect(byAttr(r, "data-browser-status")[0]!.props["data-browser-status"]).toBe("idle");
  });
});

describe("setup", () => {
  it("an unsupported machine gets a plain sentence and no button", () => {
    const r = render(
      <InstallScreen
        name="Popo"
        engine={{ supported: false, installed: false, version: null, downloadBytes: null }}
        install={initialBrowserState.install}
        onInstall={() => {}}
      />,
    );
    expect(visibleText(r)).toContain("isn't available on this Mac");
    expect(byAttr(r, "data-browser-install-button")).toHaveLength(0);
  });
  it("offers the one-time download with its size, then shows real progress, and recovers from a failure", async () => {
    engineNow = snap(false);
    const { connector, fake, push } = fakeConnector();
    const r = await mount(connector);
    await open(fake);
    await feed(push, state({ running: false, tabs: [] }), engine(false));
    expect(visibleText(r)).toContain("Give blobs a browser");
    expect(visibleText(r)).toContain("Set up (98 MB)");
    expect(visibleText(r)).toContain("one-time download");
    const button = byAttr(r, "data-browser-install-button")[0]!;
    await act(async () => button.props.onClick());
    expect(engineCalls).toContain("install");
    await feed(push, {
      fraction: 0.5,
      total: 98 * 1048576,
      received: 49 * 1048576,
      phase: "download",
      state: "running",
      t: "install",
    });
    expect(visibleText(r)).toContain("Setting up the blob browser");
    expect(visibleText(r)).toContain("Downloading 49 MB of 98 MB");
    const bar = find(r, (i) => i.props.role === "progressbar")[0]!;
    expect(bar.props["aria-valuenow"]).toBe(50);
    await feed(push, {
      fraction: 1,
      total: 0,
      received: 0,
      phase: "verify",
      state: "running",
      t: "install",
    });
    expect(visibleText(r)).toContain("Checking the download");
    await feed(push, {
      message: "engine download failed: HTTP 503",
      fraction: 0,
      total: 0,
      received: 0,
      phase: "error",
      state: "error",
      t: "install",
    });
    expect(visibleText(r)).toContain("Setup didn't finish");
    expect(visibleText(r)).toContain("engine download failed: HTTP 503");
    expect(visibleText(r)).toContain("Try again");
    // success: the setup screen goes away on its own
    engineNow = snap(true, { state: "done", phase: "done", fraction: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await feed(push, engine(true), {
      fraction: 1,
      total: 0,
      received: 0,
      phase: "done",
      state: "done",
      t: "install",
    });
    expect(byAttr(r, "data-browser-install")).toHaveLength(0);
    // the live view was reconnected once the engine existed
    await open(fake);
    await feed(push, state({ running: false, tabs: [] }));
    expect(visibleText(r)).toContain("Popo hasn't opened a page yet");
  });
});

describe("empty and live states", () => {
  it("shows the address, the title tab strip with several tabs, and the status of a working blob", async () => {
    const { connector, fake, push } = fakeConnector();
    const r = await mount(connector);
    await open(fake);
    await feed(
      push,
      engine(true),
      state({
        tabs: [
          {
            active: true,
            url: "https://www.cinema.example/showtimes?day=2",
            title: "Rialto Cinema",
            index: 0,
          },
          { index: 1, title: "Reviews", url: "https://reviews.example/", active: false },
        ],
        tool: "browser_navigate",
        working: true,
      }),
    );
    const t = visibleText(r);
    expect(t).toContain("cinema.example");
    expect(t).toContain("/showtimes?day=2");
    expect(t).toContain("Working");
    expect(byAttr(r, "data-browser-status")[0]?.props["data-browser-status"]).toBe("working");
    const tabs = find(r, (i) => i.props.role === "tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.props["aria-selected"]).toBe(true);
    // picking a tab asks the daemon
    await act(async () => tabs[1]!.props.onClick());
    expect(fake.sent.at(-1)).toEqual({ t: "tab", index: 1 });
  });
  it("says what the blob has not done yet, in the blob's name", async () => {
    const { connector, fake, push } = fakeConnector();
    const r = await mount(connector);
    await open(fake);
    await feed(push, state({ running: false, tabs: [] }), engine(true));
    expect(visibleText(r)).toContain("Popo hasn't opened a page yet");
    expect(visibleText(r)).toContain("Closed");
  });
});

describe("connecting", () => {
  it("shows 'Reconnecting' and then a retry when the service is unreachable", async () => {
    const { connector, fake } = fakeConnector();
    const r = await mount(connector);
    for (let i = 0; i < 3; i++) {
      await act(async () => fake.handlers?.onClose({ code: 1006, wasOpen: false }));
      if (i < 2) expect(visibleText(r)).toContain("Reconnecting");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
    }
    expect(visibleText(r)).toContain("Couldn't connect");
    expect(visibleText(r)).toContain("Retry");
  });
  it("opens the blob's live socket while mounted and closes it on unmount", async () => {
    const { connector, fake, push } = fakeConnector();
    const r = await mount(connector);
    expect(fake.blobId).toBe("blob_popo");
    expect(visibleText(r)).toContain("Connecting");
    await open(fake);
    expect(fake.sent[0]).toMatchObject({ t: "ping" });
    await feed(push, state(), engine(true));
    expect(visibleText(r)).toContain("Idle");
    act(() => r.unmount());
    renderer = null;
    expect(fake.closed).toBe(true);
  });
});
