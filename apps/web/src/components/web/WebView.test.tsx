import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_WEB_APPEARANCE,
  DEFAULT_WEB_PROFILE_ID,
  DEFAULT_WEB_ZOOM_FACTOR,
  FILL_WEB_VIEWPORT,
  HostId,
  ThreadId,
} from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { act, Profiler } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

/** Mutable scenario knobs and spies shared with the mocked modules below. */
const ctl = vi.hoisted(() => ({
  isLoading: false,
  noSessions: false,
  floating: false,
  daemonUrl: "http://172.25.85.75:3773",
  // callbacks the stubbed children hand back to us
  pickElementClick: null as (() => void) | null,
  nativePipClick: null as (() => void) | null,
  emptyStateOpen: null as ((url: string) => void) | null,
  addressBarSubmit: null as ((url: string) => void) | null,
  // spies
  navigateTab: vi.fn(async (_tab: string, _url: string): Promise<void> => undefined),
  rememberUrl: vi.fn(),
  recordVisit: vi.fn(),
  pickElement: vi.fn(),
  popoutOpen: vi.fn(async (_tab: string): Promise<void> => undefined),
  popoutClose: vi.fn(async (_tab: string): Promise<void> => undefined),
  closeDock: vi.fn(),
  addImage: vi.fn(),
  addAnnotation: vi.fn(),
}));

const NO_HISTORY: never[] = [];
const DEFAULTS = {
  profileId: DEFAULT_WEB_PROFILE_ID,
  profiles: BUILT_IN_BROWSER_PROFILES,
  appearance: DEFAULT_WEB_APPEARANCE,
  zoomFactor: DEFAULT_WEB_ZOOM_FACTOR,
  viewport: FILL_WEB_VIEWPORT,
};

vi.mock("~/stores/webHistoryStore", () => ({
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT: 50,
  useThreadRecentHistory: () => NO_HISTORY,
  rememberThreadVisit: ctl.recordVisit,
  removeUrlForThread: vi.fn(),
  setTitleForThreadUrl: vi.fn(),
}));
vi.mock("~/atoms/session", async (loadReal) => ({
  ...(await loadReal<typeof import("~/atoms/session")>()),
  readPreparedLink: () => ({ httpBaseUrl: ctl.daemonUrl }),
}));
// Stub the direct dependency so the settings/connection graph is not pulled in.
vi.mock("~/webview/browserDefaults", () => ({
  getBrowserDefaults: () => DEFAULTS,
  usePreviewDefaults: () => DEFAULTS,
  browserDefaultOpenProfileId: () => DEFAULT_WEB_PROFILE_ID,
  browserDefaultOpenViewport: () => FILL_WEB_VIEWPORT,
  browserDefaultTabState: () => ({
    colorScheme: DEFAULT_WEB_APPEARANCE,
    zoomFactor: DEFAULT_WEB_ZOOM_FACTOR,
  }),
  browserResponsiveViewportForToggle: () => ({
    height: 600,
    _tag: "freeform" as const,
    width: 900,
  }),
}));
vi.mock("~/stores/promptDraftStore", () => ({
  usePromptDraftStore: (
    pick: (s: { addPreviewAnnotation: () => void; addImage: () => void }) => unknown,
  ) => pick({ addImage: ctl.addImage, addPreviewAnnotation: ctl.addAnnotation }),
}));
vi.mock("~/localApi", () => ({ localApiOrThrow: vi.fn() }));
vi.mock("~/stores/webStateStore", () => ({
  rememberWebUrl: ctl.rememberUrl,
  updateWebDaemonSnapshot: vi.fn(),
  useThreadWebState: () => ({
    activeTabId: "tab-1",
    recentlySeenUrls: [],
    sessions: ctl.noSessions
      ? {}
      : {
          "tab-1": {
            tabId: "tab-1",
            threadId: "thread-1",
            updatedAt: "2026-07-13T00:00:00.000Z",
            canGoBack: false,
            canGoForward: false,
            navStatus: { _tag: "Success", title: "Example", url: "http://example.com/" },
          },
        },
    desktopByTabId: {
      "tab-1": {
        controller: "none",
        audible: false,
        audioMuted: false,
        colorScheme: "system",
        zoomFactor: 1,
        canGoBack: false,
        canGoForward: false,
        hasWebContents: true,
        loading: ctl.isLoading,
        pictureInPicture: ctl.floating,
      },
    },
  }),
}));
vi.mock("~/atoms/hosts", () => ({
  useHostHttpBaseUrl: () => ctl.daemonUrl,
  useHost: () => ({ label: "WSL" }),
}));
vi.mock("~/atoms/preview", () => ({ webHost: { open: {}, resize: {} } }));
vi.mock("~/atoms/use-atom-command", () => ({ useAtomAction: () => vi.fn() }));
vi.mock("~/webview/browserScreencast", () => ({
  useActiveBrowserScreencastTabIds: () => new Set(),
  startBrowserScreencast: vi.fn(),
  stopBrowserScreencast: vi.fn(),
  isBrowserScreencastStartCancelledError: vi.fn(() => false),
  findActiveBrowserScreencastRuntimeTabId: vi.fn(() => null),
}));
vi.mock("~/webview/browserSurfaceStore", () => ({
  usePreviewDockStore: (pick: (s: { byTabId: Record<string, { rect?: unknown }> }) => unknown) =>
    pick({ byTabId: {} }),
}));
vi.mock("~/stores/dockStore", () => ({
  useDockStore: { getState: () => ({ close: ctl.closeDock }) },
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: vi.fn() },
  threadToast: vi.fn(),
}));
vi.mock("./webBridge", () => ({
  webBridge: {
    navigate: ctl.navigateTab,
    pickElement: ctl.pickElement,
    pictureInPicture: { open: ctl.popoutOpen, close: ctl.popoutClose },
  },
}));
vi.mock("./WebChromeRow", () => ({
  WebChromeRow: (props: {
    onSubmit: (url: string) => void;
    onPickElement?: () => void;
    trailingActions?: { props: { onNativePictureInPicture?: () => void } };
  }) => {
    ctl.addressBarSubmit = props.onSubmit;
    ctl.pickElementClick = props.onPickElement ?? null;
    ctl.nativePipClick = props.trailingActions?.props.onNativePictureInPicture ?? null;
    return null;
  },
}));
vi.mock("./WebEmptyState", () => ({
  WebEmptyState: (props: { onOpenUrl: (url: string) => void }) => {
    ctl.emptyStateOpen = props.onOpenUrl;
    return null;
  },
}));
vi.mock("./WebMoreMenu", () => ({
  WebMoreMenu: (props: { onNativePictureInPicture: () => void }) => {
    ctl.nativePipClick = props.onNativePictureInPicture;
    return null;
  },
}));
vi.mock("./useWebSession", () => ({ useWebSession: vi.fn() }));
vi.mock("~/webview/BrowserSurfaceSlot", () => ({ BrowserSurfaceSlot: () => null }));
vi.mock("./AgentBrowserCursor", () => ({ AgentBrowserCursor: () => null }));
vi.mock("./ZoomIndicator", () => ({ ZoomIndicator: () => null }));
vi.mock("./WebUnreachable", () => ({ WebUnreachable: () => null }));

import { webRuntimeTabId } from "~/webview/webRuntimeTabId";

import { WebView } from "./WebView";

const THREAD = {
  threadId: ThreadId.make("thread-1"),
  hostId: HostId.make("environment-1"),
} as const;
const RUNTIME_TAB = webRuntimeTabId(THREAD, null, "tab-1");

const mount = (extra: Partial<Parameters<typeof WebView>[0]> = {}) =>
  renderToStaticMarkup(<WebView threadRef={THREAD} tabId="tab-1" visible {...extra} />);

/** A DOM-less host node, just enough for react-dom/client. */
interface FakeNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  namespaceURI: string;
  style: object;
  ownerDocument: FakeNode | null;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  textContent: string;
  [method: string]: unknown;
}

function makeNode(name: string, owner: FakeNode | null = null, nodeType = 1): FakeNode {
  const upper = name.toUpperCase();
  const node: FakeNode = {
    nodeType,
    nodeName: upper,
    tagName: upper,
    namespaceURI: "http://www.w3.org/1999/xhtml",
    style: {},
    ownerDocument: owner,
    parentNode: null,
    childNodes: [],
    set textContent(_: string) {
      node.childNodes = [];
    },
    get textContent() {
      return "";
    },
    appendChild(kid: FakeNode) {
      kid.parentNode = node;
      node.childNodes.push(kid);
      return kid;
    },
    removeChild(kid: FakeNode) {
      node.childNodes.splice(node.childNodes.indexOf(kid), 1);
      kid.parentNode = null;
      return kid;
    },
    createElement: (tag: string) => makeNode(tag, node),
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
  } as FakeNode;
  return node;
}

function stubHostDom() {
  const doc = makeNode("#document", null, 9);
  const win = {
    document: doc,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  vi.stubGlobal("HTMLIFrameElement", win.HTMLIFrameElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return doc;
}

beforeEach(() => {
  for (const spy of [
    ctl.navigateTab,
    ctl.rememberUrl,
    ctl.recordVisit,
    ctl.popoutOpen,
    ctl.popoutClose,
    ctl.closeDock,
    ctl.addImage,
    ctl.addAnnotation,
  ]) {
    spy.mockClear();
  }
  ctl.pickElement.mockReset();
  Object.assign(ctl, {
    isLoading: false,
    noSessions: false,
    floating: false,
    pickElementClick: null,
    nativePipClick: null,
    emptyStateOpen: null,
    addressBarSubmit: null,
  });
});

describe("WebView", () => {
  test("a Cmd/Ctrl+Enter annotation is stored and forwarded to the composer's send path", async () => {
    const note = {
      id: "note-1",
      comment: "Tighten this spacing",
      pageTitle: "Dashboard",
      pageUrl: "https://example.com/dashboard",
      createdAt: "2026-07-27T00:00:00.000Z",
      screenshot: null,
      styleChanges: [],
      strokes: [],
      regions: [],
      elements: [],
    };
    const send = vi.fn();
    ctl.pickElement.mockResolvedValue({ annotation: note, submission: "send" });

    mount({ onSendAnnotation: send });
    ctl.pickElementClick?.();

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(note));
    expect(ctl.addAnnotation).toHaveBeenCalledWith(THREAD, note);
  });

  test("the floating preview window toggles open and closed from the secondary action", async () => {
    mount();
    ctl.nativePipClick?.();
    await vi.waitFor(() => expect(ctl.popoutOpen).toHaveBeenCalledWith(RUNTIME_TAB));

    ctl.floating = true;
    mount();
    ctl.nativePipClick?.();
    await vi.waitFor(() => expect(ctl.popoutClose).toHaveBeenCalledWith(RUNTIME_TAB));
  });

  test("a localhost server picked on the empty state is re-pointed at the remote host and remembered", async () => {
    ctl.noSessions = true;
    mount();

    expect(ctl.emptyStateOpen).not.toBeNull();
    ctl.emptyStateOpen?.("http://localhost:5173/app?mode=test#top");
    const mapped = "http://172.25.85.75:5173/app?mode=test#top";

    await vi.waitFor(() => expect(ctl.navigateTab).toHaveBeenCalledWith(RUNTIME_TAB, mapped));
    expect(ctl.rememberUrl).toHaveBeenCalledWith(
      { threadId: "thread-1", hostId: "environment-1" },
      mapped,
    );
    await vi.waitFor(() =>
      expect(ctl.recordVisit).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: expect.anything() }),
        "http://localhost:5173/app?mode=test#top",
      ),
    );
  });

  test("submitting an address records the normalised URL in history", async () => {
    mount();
    ctl.addressBarSubmit?.("localhost:3000/admin");
    await vi.waitFor(() =>
      expect(ctl.recordVisit).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: expect.anything() }),
        "http://localhost:3000/admin",
      ),
    );
  });

  test.each([
    ["https://localhost:9443/x?a=1#frag", "https://localhost:9443/x?a=1#frag"],
    ["localhost:4000/app", "http://localhost:4000/app"],
  ])("a typed localhost URL (%s) is kept as typed", async (typed, expected) => {
    mount();
    expect(ctl.addressBarSubmit).not.toBeNull();
    ctl.addressBarSubmit?.(typed);

    await vi.waitFor(() => expect(ctl.navigateTab).toHaveBeenCalledWith(RUNTIME_TAB, expected));
    expect(ctl.rememberUrl).toHaveBeenCalledWith(
      { threadId: "thread-1", hostId: "environment-1" },
      expected,
    );
  });

  test("time passing while a page loads does not re-render the view", async () => {
    vi.useFakeTimers();
    ctl.isLoading = true;
    const doc = stubHostDom();
    const { createRoot } = await import("react-dom/client");
    const container = (doc.createElement as (t: string) => unknown)("div") as Element;
    const root = createRoot(container);
    const renders = vi.fn();

    try {
      await act(() => {
        root.render(
          <Profiler id="web-view" onRender={renders}>
            <WebView threadRef={THREAD} tabId="tab-1" visible />
          </Profiler>,
        );
      });
      const rendersBefore = renders.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      expect(renders.mock.calls.length).toBe(rendersBefore);
    } finally {
      await act(() => root.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
