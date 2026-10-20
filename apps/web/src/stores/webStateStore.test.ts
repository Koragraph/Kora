import { hostThreadKey, hostThreadRef } from "@kora/client-runtime/host";
import { ThreadId, type HostId, type WebEvent, type WebSessionSnapshot } from "@kora/contracts";
import { beforeEach, describe, expect, test } from "vite-plus/test";

import { koraAtomRegistry } from "../wire/atomRegistry";
import {
  __testing,
  applyDesktopNavStatus,
  applyWebDaemonEvent as applyEventAt,
  applyWebDaemonSnapshot,
  applyWebShellState,
  beginWebSessionClose,
  cancelWebSessionClose,
  readThreadWebState,
  reconcileWebDaemonSessions,
  rememberWebUrl,
  resetWebStateForTests,
  setActiveWebTab,
  updateWebDaemonSnapshot,
  webStateAtom,
} from "./webStateStore";

const HOST = "env-1" as HostId;
const THREAD = ThreadId.make("thread-1");
const ref = hostThreadRef(HOST, THREAD);
const otherRef = hostThreadRef(HOST, ThreadId.make("thread-2"));

const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
const loading = (url = "http://localhost:5173/") => ({ _tag: "Loading" as const, url, title: "" });
const page = (url: string, title = "") => ({ _tag: "Success" as const, url, title });

function snap(over: Partial<WebSessionSnapshot> = {}): WebSessionSnapshot {
  return {
    threadId: "thread-1",
    tabId: "tab_a",
    navStatus: loading(),
    canGoBack: false,
    canGoForward: false,
    updatedAt: at(0),
    ...over,
  };
}

/** Desktop-side state of a tab, everything idle unless overridden. */
const shell = (over: Record<string, unknown> = {}) => ({
  favicon: null as { capturedAt: number; pageUrl: string; dataUrl: string } | null,
  controller: "none" as const,
  audible: false,
  audioMuted: false,
  colorScheme: "system" as const,
  pictureInPicture: false,
  zoomFactor: 1,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  hasWebContents: true,
  ...over,
});

// Events get a rising revision from one fake server epoch, like the real stream.
type Draft = WebEvent extends infer E
  ? E extends { readonly revision: number }
    ? Omit<E, "revision" | "serverEpoch">
    : never
  : never;
const EPOCH = "server-a";
let revision = 0;
const send = (draft: Draft) =>
  applyEventAt(ref, { ...draft, serverEpoch: EPOCH, revision: ++revision } as WebEvent);
const sendRaw = (revisionNo: number, draft: Draft, epoch = EPOCH) =>
  applyEventAt(ref, { ...draft, serverEpoch: epoch, revision: revisionNo } as WebEvent);

const opened = (snapshot: WebSessionSnapshot): Draft => ({
  type: "opened",
  snapshot,
  tabId: snapshot.tabId,
  threadId: "thread-1",
  createdAt: snapshot.updatedAt,
});
const closed = (tabId: string, second = 1): Draft => ({
  type: "closed",
  tabId,
  threadId: "thread-1",
  createdAt: at(second),
});
const state = () => readThreadWebState(ref);

beforeEach(() => {
  revision = 0;
  resetWebStateForTests();
});

describe("desktop navigation reports", () => {
  const report = (tabId: string, canGoBack: boolean, navStatus: ReturnType<typeof page>) =>
    applyDesktopNavStatus(ref, { tabId, canGoBack, canGoForward: false, navStatus });

  test("a report for a tab nobody knows is ignored", () => {
    applyWebDaemonSnapshot(ref, snap({ navStatus: { _tag: "Idle" } }));
    report("tab_other", false, page("http://x.test/", "x"));
    expect(state().snapshot?.navStatus._tag).toBe("Idle");
  });

  test("a blank tab leaves its start screen when the desktop reports a page", () => {
    applyWebDaemonSnapshot(ref, snap({ navStatus: { _tag: "Idle" } }));
    report("tab_a", true, page("http://localhost:5814/", "Test page"));
    expect(state().snapshot?.navStatus).toEqual(page("http://localhost:5814/", "Test page"));
    expect(state().snapshot?.canGoBack).toBe(true);
  });
});

describe("recently seen URLs", () => {
  test("newest first, deduplicated and capped", () => {
    const limit = __testing.RECENT_URL_LIMIT;
    for (let i = 0; i < limit + 5; i++) rememberWebUrl(ref, `http://localhost:${5000 + i}/`);
    expect(state().recentlySeenUrls.length).toBeLessThanOrEqual(limit);
    expect(state().recentlySeenUrls[0]).toBe(`http://localhost:${5000 + limit + 4}/`);
  });

  test("opening a tab remembers its URL and closing it keeps the memory", () => {
    send(opened(snap()));
    expect(state().recentlySeenUrls).toContain("http://localhost:5173/");
    send(closed("tab_a"));
    expect(state().snapshot).toBeNull();
    expect(state().recentlySeenUrls).toContain("http://localhost:5173/");
  });
});

describe("snapshots", () => {
  test("an older snapshot (stale SWR data) never replaces a newer streamed one", () => {
    applyWebDaemonSnapshot(
      ref,
      snap({ updatedAt: at(2), navStatus: page("http://localhost:5173/new", "New") }),
    );
    applyWebDaemonSnapshot(
      ref,
      snap({ updatedAt: at(1), navStatus: page("http://localhost:5173/old", "Old") }),
    );
    expect(state().snapshot?.navStatus).toEqual(page("http://localhost:5173/new", "New"));
  });

  test("a null snapshot clears a thread that had one", () => {
    applyWebDaemonSnapshot(ref, snap());
    applyWebDaemonSnapshot(ref, null);
    expect(state().snapshot).toBeNull();
  });

  test("updating a background tab's snapshot does not change the active tab", () => {
    const background = snap({ tabId: "tab_a" });
    const active = snap({ tabId: "tab_b", updatedAt: at(1) });
    applyWebDaemonSnapshot(ref, background);
    applyWebDaemonSnapshot(ref, active);

    const resized = {
      ...background,
      updatedAt: at(2),
      viewport: { _tag: "freeform" as const, width: 900, height: 700 },
    };
    updateWebDaemonSnapshot(ref, resized);

    expect(state().activeTabId).toBe("tab_b");
    expect(state().snapshot?.tabId).toBe("tab_b");
    expect(state().sessions["tab_a"]).toEqual(resized);
  });

  test("several tabs are retained and setting the active one switches the desktop overlay", () => {
    const first = snap();
    const second = snap({ tabId: "tab_2", updatedAt: "2026-01-02T00:00:00.000Z" });
    applyWebDaemonSnapshot(ref, first);
    applyWebDaemonSnapshot(ref, second);
    applyWebShellState(ref, first.tabId, shell({ canGoBack: true }));
    setActiveWebTab(ref, first.tabId);

    expect(Object.keys(state().sessions)).toEqual(["tab_a", "tab_2"]);
    expect(state().snapshot?.tabId).toBe("tab_a");
    expect(state().desktopOverlay?.canGoBack).toBe(true);
  });

  test("every thread has its own atom and its own state", () => {
    const key = hostThreadKey(ref);
    expect(webStateAtom(key)).toBe(webStateAtom(key));
    expect(webStateAtom(key)).not.toBe(webStateAtom(hostThreadKey(otherRef)));

    applyWebDaemonSnapshot(ref, snap());
    expect(state().snapshot?.tabId).toBe("tab_a");
    expect(readThreadWebState(otherRef)).toEqual(__testing.EMPTY_THREAD_WEB_STATE);
  });
});

describe("server events", () => {
  test("opened makes the snapshot current; a later opened for another tab replaces it", () => {
    send(opened(snap({ tabId: "tab_a" })));
    send(opened(snap({ tabId: "tab_b" })));
    expect(state().snapshot?.tabId).toBe("tab_b");
  });

  test("navigated updates the URL shown", () => {
    const first = snap();
    send(opened(first));
    send({
      type: "navigated",
      snapshot: { ...first, navStatus: page("http://localhost:5173/about", "About") },
      tabId: first.tabId,
      threadId: "thread-1",
      createdAt: at(1),
    });
    expect(state().snapshot?.navStatus).toEqual(page("http://localhost:5173/about", "About"));
  });

  test("failed flips the matching tab to LoadFailed and ignores other tabs", () => {
    send(opened(snap({ tabId: "tab_a" })));
    const failure = (tabId: string, url: string): Draft => ({
      type: "failed",
      tabId,
      threadId: "thread-1",
      url,
      title: "",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
      createdAt: at(1),
    });

    send(failure("tab_b", "http://localhost:9999/"));
    expect(state().snapshot?.navStatus._tag).toBe("Loading");

    send(failure("tab_a", "http://localhost:5173/"));
    expect(state().snapshot?.navStatus._tag).toBe("LoadFailed");
  });

  test("resized updates a background tab's viewport only", () => {
    const active = snap({ tabId: "tab_a" });
    const background = snap({ tabId: "tab_b" });
    applyWebDaemonSnapshot(ref, background);
    applyWebDaemonSnapshot(ref, active);

    send({
      type: "resized",
      snapshot: {
        ...background,
        updatedAt: at(1),
        viewport: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
      },
      tabId: "tab_b",
      threadId: "thread-1",
      createdAt: at(1),
    });

    expect(state().activeTabId).toBe("tab_a");
    expect(state().sessions["tab_b"]?.viewport).toEqual({
      _tag: "preset",
      presetId: "pixel-8",
      width: 412,
      height: 915,
    });
  });

  test("closing a different tab does nothing to the current one", () => {
    send(opened(snap({ tabId: "tab_a" })));
    send(closed("tab_b"));
    expect(state().snapshot?.tabId).toBe("tab_a");
  });

  test("an 'opened' older than the tab's close does not bring it back", () => {
    const first = snap();
    send(opened(first));
    send(closed(first.tabId));
    sendRaw(1, opened(first));
    expect(state().sessions).toEqual({});
  });

  test("the desktop overlay changes without touching the daemon snapshot", () => {
    const first = snap();
    send(opened(first));
    applyWebShellState(ref, first.tabId, shell({ canGoBack: true }));
    expect(state().desktopOverlay?.canGoBack).toBe(true);
    expect(state().snapshot?.canGoBack).toBe(false);
  });

  test("identical desktop state is not published twice", () => {
    const first = snap();
    applyWebDaemonSnapshot(ref, first);
    const overlay = shell({
      canGoBack: true,
      favicon: {
        capturedAt: 1,
        pageUrl: "https://example.com",
        dataUrl: "data:image/png;base64,AA==",
      },
    });
    let publishes = 0;
    const stop = koraAtomRegistry.subscribe(
      webStateAtom(hostThreadKey(ref)),
      () => void publishes++,
    );

    applyWebShellState(ref, first.tabId, overlay);
    applyWebShellState(ref, first.tabId, { ...overlay, favicon: { ...overlay.favicon! } });
    stop();

    expect(publishes).toBe(1);
  });
});

describe("closing a tab", () => {
  test("it disappears at once, before the server confirms, and focus moves to a remaining tab", () => {
    const first = snap({ tabId: "tab_a" });
    const second = snap({ tabId: "tab_b", updatedAt: at(1) });
    applyWebDaemonSnapshot(ref, first);
    applyWebDaemonSnapshot(ref, second);

    beginWebSessionClose(ref, "tab_b");

    expect(Object.keys(state().sessions)).toEqual(["tab_a"]);
    expect(state().activeTabId).toBe("tab_a");
    expect(state().snapshot?.tabId).toBe("tab_a");
  });

  test("a stale list snapshot cannot bring back a tab being closed", () => {
    const only = snap();
    applyWebDaemonSnapshot(ref, only);
    beginWebSessionClose(ref, only.tabId);
    applyWebDaemonSnapshot(ref, only);
    expect([state().sessions, state().snapshot]).toEqual([{}, null]);
  });

  test("the server's own close event arriving afterwards is a no-op", () => {
    const only = snap();
    applyWebDaemonSnapshot(ref, only);
    beginWebSessionClose(ref, only.tabId);
    send(closed(only.tabId));
    expect([state().sessions, state().snapshot]).toEqual([{}, null]);
  });

  test("a failed close can be rolled back", () => {
    const only = snap();
    applyWebDaemonSnapshot(ref, only);
    beginWebSessionClose(ref, only.tabId);
    cancelWebSessionClose(ref, only, only.tabId);
    expect(state().sessions).toEqual({ [only.tabId]: only });
    expect(state().snapshot).toEqual(only);
  });
});

describe("reconciling with the server's session list", () => {
  test("an authoritative empty list clears stale sessions", () => {
    applyWebDaemonSnapshot(ref, snap());
    reconcileWebDaemonSessions(ref, { sessions: [], serverEpoch: EPOCH, revision: 1 });
    expect([state().sessions, state().activeTabId, state().snapshot]).toEqual([{}, null, null]);
  });

  test("a list older than the latest event is ignored", () => {
    const first = snap();
    send(opened(first));
    reconcileWebDaemonSessions(ref, { sessions: [], serverEpoch: EPOCH, revision: 0 });
    expect(state().sessions).toEqual({ [first.tabId]: first });
  });

  test("tabs missing from the list are dropped, with their desktop state, and the active tab stays focused", () => {
    const keep = snap({ tabId: "tab_a" });
    const drop = snap({ tabId: "tab_stale", updatedAt: at(1) });
    applyWebDaemonSnapshot(ref, drop);
    applyWebDaemonSnapshot(ref, keep);
    applyWebShellState(ref, drop.tabId, shell());

    reconcileWebDaemonSessions(ref, { sessions: [keep], serverEpoch: EPOCH, revision: 1 });

    expect(Object.keys(state().sessions)).toEqual(["tab_a"]);
    expect(state().activeTabId).toBe("tab_a");
    expect(state().snapshot).toEqual(keep);
    expect(state().desktopByTabId["tab_stale"]).toBeUndefined();
  });

  test("a restarted server (new epoch) may report a lower revision", () => {
    sendRaw(12, opened(snap()));
    reconcileWebDaemonSessions(ref, { sessions: [], serverEpoch: "server-b", revision: 0 });
    expect(state().sessions).toEqual({});
    expect([state().serverEpoch, state().serverRevision]).toEqual(["server-b", 0]);
  });

  test("a server restart discards raw-tab state: suppressed ids, desktop tabs and overlay", () => {
    const before = snap({ updatedAt: at(2), navStatus: page("https://old.example", "Old") });
    sendRaw(12, opened(before));
    beginWebSessionClose(ref, before.tabId);
    applyWebShellState(ref, before.tabId, shell());

    const after = snap({ updatedAt: at(1), navStatus: page("https://new.example", "New") });
    reconcileWebDaemonSessions(ref, { sessions: [after], serverEpoch: "server-b", revision: 0 });

    expect(state().sessions[after.tabId]).toEqual(after);
    expect(state().suppressedTabIds).toEqual(new Set());
    expect(state().desktopByTabId).toEqual({});
    expect(state().desktopOverlay).toBeNull();
  });
});
