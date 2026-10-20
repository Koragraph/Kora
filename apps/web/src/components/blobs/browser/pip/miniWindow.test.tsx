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
  TooltipPopup: ({ children }: { children?: React.ReactNode }) => <i data-tooltip>{children}</i>,
  TooltipTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode;
    render?: React.ReactElement<Record<string, unknown>>;
  }) => (render ? cloneElement(render, undefined, children) : <>{children}</>),
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock("~/components/blobs/avatar", () => ({ BlobAvatar: () => <i data-avatar /> }));

// the app around the host: Kora surface, a thread route, one blob on the roster, the side panel store
const nav = vi.hoisted(() => ({
  pathname: "/h1/t1",
  navigate: vi.fn(async () => undefined),
  surface: "blobs",
  show: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: (o: { select: (l: { pathname: string }) => string }) =>
    o.select({ pathname: nav.pathname }),
  useNavigate: () => nav.navigate,
}));
vi.mock("~/components/assistant/surfaceStore", () => ({
  useAppSurfaceStore: () => [nav.surface, () => undefined],
}));
vi.mock("../../shell/useBlobRoster", () => ({
  useBlobRoster: () => ({
    entries: new Map([["blob_popo", { blob: { name: "Popo" }, outfit: {} }]]),
  }),
}));
vi.mock("../../chat/blobPanelStore", () => ({
  useBlobPanel: () => ({ show: nav.show }),
}));

import { type ServerMessage } from "../browserModel";
import { BrowserPanel } from "../BrowserPanel";
import { LiveConnectorProvider, type LiveConnector, type LiveHandlers } from "../liveConnection";
import { EngineApiProvider, type EngineApi, type EngineSnapshot } from "../useBrowserEngine";
import { BrowserMiniHost } from "./BrowserMiniHost";
import {
  PIP_CORNER_KEY,
  PIP_LINGER_MS,
  nearestCorner,
  pipInsets,
  pipWidthFor,
  readPipCorner,
} from "./pipModel";
import { resetPipStoreForTests, usePipStore } from "./pipStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ------------------------------------------------------------------ fakes

interface Conn {
  handlers: LiveHandlers;
  sent: Array<Record<string, unknown>>;
  closed: boolean;
}
function fakeConnector() {
  const conns: Conn[] = [];
  const connector: LiveConnector = (_blobId, handlers) => {
    const c: Conn = { handlers, sent: [], closed: false };
    conns.push(c);
    return {
      send: (raw) => c.sent.push(JSON.parse(raw)),
      close: () => {
        c.closed = true;
      },
      get isOpen() {
        return !c.closed;
      },
    };
  };
  const live = () => conns.filter((c) => !c.closed);
  return { connector, conns, live };
}

const state = (over: Record<string, unknown> = {}): ServerMessage =>
  ({
    t: "state",
    running: true,
    working: true,
    tool: "navigate",
    controller: "agent",
    idleMs: 0,
    releaseAfterMs: 8000,
    youControl: false,
    tabs: [
      {
        index: 0,
        title: "Example Domain",
        url: "https://www.example.com/some/long/path?q=1",
        active: true,
      },
    ],
    approvals: [],
    viewport: { width: 1280, height: 800 },
    ...over,
  }) as ServerMessage;

const engineSnap: EngineSnapshot = {
  install: { message: null, fraction: 0, total: 0, received: 0, phase: "download", state: "idle" },
  downloadBytes: 1,
  version: "155",
  installed: true,
  supported: true,
};
const engineApi: EngineApi = { install: async () => engineSnap, status: async () => engineSnap };

let renderer: ReactTestRenderer | null = null;
const boxRect = { left: 900, top: 500, width: 360, height: 225 };
const nodeMock = (el: { type: unknown; props: Record<string, unknown> }) => {
  if (el.type === "canvas")
    return {
      focus: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      getContext: () => ({ drawImage: vi.fn() }),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 360, height: 225 }),
    };
  if (el.type === "div" && "data-browser-mini" in el.props)
    return {
      contains: () => false,
      getBoundingClientRect: () => ({
        ...boxRect,
        right: boxRect.left + boxRect.width,
        bottom: boxRect.top + boxRect.height,
      }),
    };
  return null;
};

function App(props: { connector: LiveConnector; pane: boolean }) {
  return (
    <EngineApiProvider api={engineApi}>
      <LiveConnectorProvider connector={props.connector}>
        <BrowserMiniHost />
        {props.pane ? <BrowserPanel blobId="blob_popo" blobName="Popo" /> : null}
      </LiveConnectorProvider>
    </EngineApiProvider>
  );
}
async function mount(connector: LiveConnector, pane = false) {
  await act(async () => {
    renderer = create(<App connector={connector} pane={pane} />, {
      createNodeMock: nodeMock as never,
    });
  });
  return renderer!;
}
const byAttr = (r: ReactTestRenderer, attr: string): ReactTestInstance[] =>
  r.root.findAll((i) => typeof i.type === "string" && attr in i.props);
const one = (r: ReactTestRenderer, attr: string) => {
  const all = byAttr(r, attr);
  expect(all).toHaveLength(1);
  return all[0]!;
};
const textOf = (i: ReactTestInstance): string =>
  i.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");
const browse = (turn = "turn_1") =>
  act(async () =>
    usePipStore
      .getState()
      .signal({ blobId: "blob_popo", thread: { hostId: "h1", threadId: "t1" }, turn }),
  );
const openWith = async (c: Conn, ...ms: ServerMessage[]) =>
  act(async () => {
    c.handlers.onOpen();
    for (const m of ms) c.handlers.onText(JSON.stringify(m));
  });

let store: Map<string, string>;
beforeEach(() => {
  resetPipStoreForTests();
  nav.pathname = "/h1/t1";
  nav.surface = "blobs";
  nav.navigate.mockClear();
  nav.show.mockClear();
  store = new Map();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
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
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

// ------------------------------------------------------------------ tests

describe("placement", () => {
  const anchor = { left: 300, top: 0, right: 1440, bottom: 900 };
  const viewport = { width: 1440, height: 900 };
  it("sits bottom-right above the composer, never over it", () => {
    const composer = { left: 400, top: 760, right: 1340, bottom: 880 };
    const at = pipInsets({ anchor, avoid: composer, corner: "bottom-right", viewport });
    expect(at).toEqual({ right: 16, bottom: 900 - (760 - 12) });
    // the box's bottom edge (viewport.height - bottom) is above the composer's top
    expect(viewport.height - at.bottom!).toBeLessThan(composer.top);
  });
  it("without a composer it keeps the margin; top corners clear the header", () => {
    expect(pipInsets({ anchor, avoid: null, corner: "bottom-left", viewport })).toEqual({
      left: 316,
      bottom: 16,
    });
    expect(pipInsets({ anchor, avoid: null, corner: "top-right", viewport })).toEqual({
      right: 16,
      top: 64,
    });
  });
  it("is 360 px wide, narrower in a narrow area, and snaps to the nearest corner", () => {
    expect(pipWidthFor(1100)).toBe(360);
    expect(pipWidthFor(300)).toBe(268);
    expect(nearestCorner(400, 100, anchor)).toBe("top-left");
    expect(nearestCorner(1400, 850, anchor)).toBe("bottom-right");
  });
});

describe("the floating mini-window", () => {
  it("appears when the agent starts browsing and shows the live picture", async () => {
    const { connector, live } = fakeConnector();
    const r = await mount(connector);
    expect(byAttr(r, "data-browser-mini")).toHaveLength(0);
    expect(live()).toHaveLength(0); // no socket before anything browses
    await browse();
    one(r, "data-browser-mini");
    one(r, "data-browser-canvas");
    expect(live()).toHaveLength(1);
  });

  it("stays away on the Code surface and in Settings", async () => {
    const { connector } = fakeConnector();
    nav.surface = "code";
    const r = await mount(connector);
    await browse();
    expect(byAttr(r, "data-browser-mini")).toHaveLength(0);
    nav.surface = "blobs";
    nav.pathname = "/settings/general";
    await act(async () => r.update(<App connector={connector} pane={false} />));
    expect(byAttr(r, "data-browser-mini")).toHaveLength(0);
  });

  it("hides while the full pane is open (one socket), and comes back when it closes", async () => {
    const { connector, live } = fakeConnector();
    const r = await mount(connector);
    await browse();
    one(r, "data-browser-mini");
    await act(async () => r.update(<App connector={connector} pane />));
    expect(byAttr(r, "data-browser-mini")).toHaveLength(0);
    one(r, "data-browser-panel");
    expect(live()).toHaveLength(1);
    await act(async () => r.update(<App connector={connector} pane={false} />));
    one(r, "data-browser-mini");
    expect(live()).toHaveLength(1);
  });

  it("the hover bar shows the hostname, with the full URL in the tooltip", async () => {
    const { connector, live } = fakeConnector();
    const r = await mount(connector);
    await browse();
    await openWith(live()[0]!, state());
    const box = one(r, "data-browser-mini");
    expect(box.props["data-browser-mini-chrome"]).toBe("hidden");
    await act(async () => box.props.onPointerEnter());
    expect(one(r, "data-browser-mini").props["data-browser-mini-chrome"]).toBe("shown");
    expect(textOf(one(r, "data-browser-mini-host"))).toBe("example.com");
    expect(textOf(one(r, "data-tooltip"))).toBe("https://www.example.com/some/long/path?q=1");
    // every light has a label
    for (const a of [
      "data-browser-mini-close",
      "data-browser-mini-minimize",
      "data-browser-mini-expand",
    ])
      expect(one(r, a).props["aria-label"]).toMatch(/Popo/);
  });

  it("red closes it for this browsing session; the next turn that browses brings it back", async () => {
    const { connector, live } = fakeConnector();
    const r = await mount(connector);
    await browse("turn_1");
    await act(async () => one(r, "data-browser-mini-close").props.onClick());
    expect(byAttr(r, "data-browser-mini")).toHaveLength(0);
    expect(live()).toHaveLength(0);
    await browse("turn_1"); // more browsing in the same turn: stays closed
    expect(byAttr(r, "data-browser-mini")).toHaveLength(0);
    await browse("turn_2");
    one(r, "data-browser-mini");
  });

  it("yellow (or Escape) minimizes to a pill with the sprite + 'browsing' that restores on click", async () => {
    const { connector, live } = fakeConnector();
    const r = await mount(connector);
    await browse();
    await act(async () => one(r, "data-browser-mini-minimize").props.onClick());
    const pill = one(r, "data-browser-mini-pill");
    expect(byAttr(r, "data-browser-mini")).toHaveLength(0);
    one(r, "data-avatar");
    expect(textOf(pill)).toContain("browsing");
    expect(pill.props["aria-label"]).toBe("Show Popo's browser");
    expect(live()).toHaveLength(1); // still listening, so "needs you" reaches the pill
    await act(async () => pill.props.onClick());
    one(r, "data-browser-mini");
    await act(async () =>
      one(r, "data-browser-mini").props.onKeyDown({
        key: "Escape",
        target: {},
        stopPropagation: () => undefined,
      }),
    );
    one(r, "data-browser-mini-pill");
  });

  it("green opens the full pane: the Computer tab of the browsing thread", async () => {
    const { connector } = fakeConnector();
    const r = await mount(connector);
    await browse();
    await act(async () => one(r, "data-browser-mini-expand").props.onClick());
    expect(nav.show).toHaveBeenCalledWith("computer");
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it("green from another screen goes to the thread first", async () => {
    const { connector } = fakeConnector();
    nav.pathname = "/blobs/blob_popo";
    const r = await mount(connector);
    await browse();
    await act(async () => one(r, "data-browser-mini-expand").props.onClick());
    expect(nav.navigate).toHaveBeenCalledWith({
      to: "/$hostId/$threadId",
      params: { hostId: "h1", threadId: "t1" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(nav.show).toHaveBeenCalledWith("computer");
  });

  it("remembers the corner it was dragged to", async () => {
    const { connector } = fakeConnector();
    expect(readPipCorner()).toBe("bottom-right");
    const r = await mount(connector);
    await browse();
    const bar = one(r, "data-browser-mini-bar");
    const ev = (x: number, y: number) => ({
      button: 0,
      pointerId: 1,
      clientX: x,
      clientY: y,
      target: { closest: () => null },
      currentTarget: { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() },
    });
    boxRect.left = 40;
    boxRect.top = 80; // dropped near the top-left of the (fallback 1280x800) area
    await act(async () => {
      bar.props.onPointerDown(ev(1000, 520));
      bar.props.onPointerMove(ev(200, 120));
    });
    await act(async () => one(r, "data-browser-mini-bar").props.onPointerUp(ev(200, 120)));
    expect(store.get(PIP_CORNER_KEY)).toBe("top-left");
    expect(one(r, "data-browser-mini").props.style).toMatchObject({ left: 16, top: 64 });
    expect(readPipCorner()).toBe("top-left");
    store.set(PIP_CORNER_KEY, "nonsense");
    expect(readPipCorner()).toBe("bottom-right");
    boxRect.left = 900;
    boxRect.top = 500;
  });

  it("a pending approval keeps the bar up with an Open action, also on the pill", async () => {
    const { connector, live } = fakeConnector();
    const r = await mount(connector);
    await browse();
    await openWith(
      live()[0]!,
      state({ approvals: [{ id: "a1", summary: "buy tickets", url: "https://cinema.example" }] }),
    );
    expect(one(r, "data-browser-mini").props["data-browser-mini-chrome"]).toBe("shown");
    expect(textOf(one(r, "data-browser-mini-needs-you"))).toContain("Popo needs your OK");
    await act(async () => one(r, "data-browser-mini-open").props.onClick());
    expect(nav.show).toHaveBeenCalledWith("computer");
    await act(async () => usePipStore.getState().minimize());
    const pill = one(r, "data-browser-mini-pill");
    expect(pill.props["data-browser-mini-attention"]).toBe("needs-you");
    expect(textOf(pill)).toContain("needs you");
  });

  it("while the user drives, the bar stays up and Hand back is right there", async () => {
    const { connector, live } = fakeConnector();
    const r = await mount(connector);
    await browse();
    const c = live()[0]!;
    await openWith(c, state({ controller: "user", youControl: true }));
    expect(one(r, "data-browser-mini").props["data-browser-mini-chrome"]).toBe("shown");
    await act(async () => one(r, "data-browser-mini-handback").props.onClick());
    expect(c.sent).toContainEqual({ t: "release" });
  });

  it("goes away on its own once the browsing has been quiet for a while", async () => {
    const { connector, live } = fakeConnector();
    const r = await mount(connector);
    await browse();
    await openWith(live()[0]!, state({ working: false, tool: null }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PIP_LINGER_MS + 1000);
    });
    expect(byAttr(r, "data-browser-mini")).toHaveLength(0);
    expect(usePipStore.getState().session).toBeNull();
  });
});
