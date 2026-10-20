import { hostProjectRef } from "@kora/client-runtime/host";
import { HostId, ProjectId, ThreadId } from "@kora/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/atoms/entities", () => ({ useThreadSummary: () => null }));
vi.mock("~/atoms/session", () => ({ usePreparedLink: () => ({ _tag: "None" }) }));

import { BROWSER_FAVICON_MAX_ENTRIES, migrateSavedFavicons } from "../webview/pageFavicon";
import * as webIconStore from "./webIconStore";

const { useBrowserFaviconStore, resolveBrowserFaviconStorage, resetBrowserFaviconsForTests } =
  webIconStore;

const { registerFaviconProjectForThread, recordFaviconForThread, recordFaviconForProject } =
  webIconStore;

const { mergeBrowserFaviconState, lookupFavicon, flushPendingFaviconsForThread } = webIconStore;

const PRIMARY_HOST = HostId.make("host-alpha");
const TARGET_PROJECT = hostProjectRef(PRIMARY_HOST, ProjectId.make("proj-core"));
const TARGET_THREAD = { hostId: PRIMARY_HOST, threadId: ThreadId.make("th-core") };

const SAMPLE_PNG = "data:image/png;base64,AAAA";

function makeFaviconPayload(url: string, timestamp: number, iconData = SAMPLE_PNG) {
  return {
    pageUrl: url,
    capturedAt: timestamp,
    dataUrl: iconData,
  };
}

describe("BrowserFaviconStore resilience and storage adapter", () => {
  beforeEach(() => {
    resetBrowserFaviconsForTests();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("relies on in-memory cache when underlying web storage write fails", () => {
    const quotaExceededStorage = {
      getItem: vi.fn().mockReturnValue("outdated"),
      setItem: vi.fn().mockImplementation(() => {
        throw new Error("QuotaExceededError");
      }),
      removeItem: vi.fn().mockImplementation(() => {
        throw new Error("SecurityError");
      }),
    };
    vi.stubGlobal("window", { localStorage: quotaExceededStorage });

    const adapter = resolveBrowserFaviconStorage();
    adapter.setItem("itemKey", "freshVal");
    expect(adapter.getItem("itemKey")).toBe("freshVal");

    adapter.removeItem("itemKey");
    expect(adapter.getItem("itemKey")).toBeNull();
  });

  it("handles throwing localStorage methods gracefully with RAM fallback", () => {
    const faultyLocalStorage = {
      getItem: vi.fn().mockImplementation(() => {
        throw new Error("Blocked read");
      }),
      setItem: vi.fn().mockImplementation(() => {
        throw new Error("Blocked write");
      }),
      removeItem: vi.fn().mockImplementation(() => {
        throw new Error("Blocked remove");
      }),
    };
    vi.stubGlobal("window", { localStorage: faultyLocalStorage });

    const storageBackend = resolveBrowserFaviconStorage();
    storageBackend.setItem("token", "payload-123");
    expect(storageBackend.getItem("token")).toBe("payload-123");

    storageBackend.removeItem("token");
    expect(storageBackend.getItem("token")).toBeNull();
  });

  it("falls back to memory store when window.localStorage getter throws", () => {
    vi.stubGlobal(
      "window",
      Object.defineProperty({}, "localStorage", {
        get() {
          throw new Error("Access denied by sandbox");
        },
      }),
    );

    const backend = resolveBrowserFaviconStorage();
    backend.setItem("keyA", "valA");
    expect(backend.getItem("keyA")).toBe("valA");
  });
});

describe("BrowserFaviconStore hydration and queue management", () => {
  beforeEach(resetBrowserFaviconsForTests);

  it("filters corrupted data while retaining store actions and transient queue", () => {
    recordFaviconForThread(
      TARGET_THREAD,
      makeFaviconPayload("http://localhost:3000/", 1),
      null,
      undefined,
    );

    const baseState = useBrowserFaviconStore.getState();
    const sanitized = mergeBrowserFaviconState(
      {
        byKey: {
          ["z".repeat(5000)]: { dataUrl: SAMPLE_PNG, capturedAt: 99 },
          "host-alpha:proj-core http://localhost:3002": { dataUrl: SAMPLE_PNG, capturedAt: 1e308 },
          "host-alpha:proj-core http://localhost:3001": {
            dataUrl: "not-a-data-url",
            capturedAt: 4,
          },
          "host-alpha:proj-core http://localhost:3000": { dataUrl: SAMPLE_PNG, capturedAt: 2 },
        },
      },
      baseState,
    );

    expect(sanitized.byKey).toEqual({
      "host-alpha:proj-core http://localhost:3000": { dataUrl: SAMPLE_PNG, capturedAt: 2 },
    });
    expect(sanitized.pendingByThreadKey).toEqual(baseState.pendingByThreadKey);
    expect(typeof sanitized.recordFavicon).toBe("function");
  });

  it("caps memory usage for pending entries per thread and per origin", () => {
    for (let thIndex = 0; thIndex < 22; thIndex++) {
      for (let pNum = 3000; pNum < 3012; pNum++) {
        recordFaviconForThread(
          { hostId: PRIMARY_HOST, threadId: ThreadId.make(`th-${thIndex}`) },
          makeFaviconPayload(`http://localhost:${pNum}/`, pNum),
          null,
          undefined,
        );
      }
    }

    const currentPending = useBrowserFaviconStore.getState().pendingByThreadKey;
    expect(Object.keys(currentPending)).toHaveLength(20);
    expect(
      Object.values(currentPending).every(
        (threadOrigins) => Object.keys(threadOrigins).length === 10,
      ),
    ).toBe(true);
  });

  it("drains buffered favicon upon subsequent project association", () => {
    recordFaviconForThread(
      TARGET_THREAD,
      makeFaviconPayload("http://localhost:8025/", 10),
      null,
      undefined,
    );

    registerFaviconProjectForThread(TARGET_THREAD, TARGET_PROJECT);

    const storedProject =
      useBrowserFaviconStore.getState().projectRefByThreadKey["host-alpha:th-core"];
    expect(storedProject).toEqual(TARGET_PROJECT);

    const drained = flushPendingFaviconsForThread(TARGET_THREAD, storedProject!, undefined);
    expect(drained).toBe(true);

    const foundIcon = lookupFavicon(
      useBrowserFaviconStore.getState().byKey,
      storedProject!,
      "http://localhost:8025/",
      null,
    );
    expect(foundIcon).toBe(SAMPLE_PNG);
  });

  it("preserves buffered icons in store state across component unmounts", () => {
    recordFaviconForThread(
      TARGET_THREAD,
      makeFaviconPayload("http://localhost:3000/", 10),
      null,
      undefined,
    );

    const snapshot = useBrowserFaviconStore.getState().pendingByThreadKey;
    useBrowserFaviconStore.setState({ pendingByThreadKey: snapshot });

    flushPendingFaviconsForThread(TARGET_THREAD, TARGET_PROJECT, "localhost");
    expect(useBrowserFaviconStore.getState().byKey).toEqual({
      "host-alpha:proj-core http://localhost:3000": { dataUrl: SAMPLE_PNG, capturedAt: 10 },
    });
  });

  it("saves direct localhost captures when projectRef is provided without active host", () => {
    const recorded = recordFaviconForThread(
      TARGET_THREAD,
      makeFaviconPayload("http://localhost:3000/", 1),
      TARGET_PROJECT,
      undefined,
    );
    expect(recorded).toBe(true);

    expect(useBrowserFaviconStore.getState().byKey).toEqual({
      "host-alpha:proj-core http://localhost:3000": { dataUrl: SAMPLE_PNG, capturedAt: 1 },
    });

    recordFaviconForThread(
      TARGET_THREAD,
      makeFaviconPayload("http://192.168.64.2:5173/", 2),
      TARGET_PROJECT,
      undefined,
    );

    expect(flushPendingFaviconsForThread(TARGET_THREAD, TARGET_PROJECT, undefined)).toBe(false);
    expect(Object.values(useBrowserFaviconStore.getState().pendingByThreadKey)[0]).toBeDefined();
  });

  it("holds onto multiple pending origins until environmental host details resolve", () => {
    const res1 = recordFaviconForThread(
      TARGET_THREAD,
      makeFaviconPayload("http://localhost:3000/", 1),
      null,
      undefined,
    );
    const res2 = recordFaviconForThread(
      TARGET_THREAD,
      makeFaviconPayload("http://localhost:5173/", 2),
      null,
      undefined,
    );

    expect(res1).toBe(false);
    expect(res2).toBe(false);

    const originEntries =
      Object.values(useBrowserFaviconStore.getState().pendingByThreadKey)[0] ?? {};
    expect(Object.keys(originEntries)).toHaveLength(2);

    const flushed = flushPendingFaviconsForThread(TARGET_THREAD, TARGET_PROJECT, "192.168.64.2");
    expect(flushed).toBe(true);

    expect(Object.keys(useBrowserFaviconStore.getState().byKey).toSorted()).toEqual([
      "host-alpha:proj-core http://localhost:3000",
      "host-alpha:proj-core http://localhost:5173",
    ]);
    expect(useBrowserFaviconStore.getState().pendingByThreadKey).toEqual({});
  });
});

describe("BrowserFaviconStore eviction and alias consistency", () => {
  beforeEach(resetBrowserFaviconsForTests);

  it("removes entry and companion host aliases atomically on store overflow", () => {
    recordFaviconForProject(
      TARGET_PROJECT,
      makeFaviconPayload("http://192.168.64.2:3000/", 100),
      "192.168.64.2",
    );

    for (let i = 1; i < BROWSER_FAVICON_MAX_ENTRIES; i++) {
      recordFaviconForProject(
        TARGET_PROJECT,
        makeFaviconPayload(`https://service-${i}.io/`, 100 + i),
        null,
      );
    }

    expect(
      lookupFavicon(
        useBrowserFaviconStore.getState().byKey,
        TARGET_PROJECT,
        "http://192.168.64.2:3000/",
        null,
      ),
    ).toBe(SAMPLE_PNG);

    recordFaviconForProject(
      TARGET_PROJECT,
      makeFaviconPayload("https://displaces-oldest.io/", 9999),
      null,
    );

    expect(
      lookupFavicon(
        useBrowserFaviconStore.getState().byKey,
        TARGET_PROJECT,
        "http://192.168.64.2:3000/",
        null,
      ),
    ).toBeNull();
  });

  it("synchronizes host aliases to the most recent canonical version", () => {
    const updatedIcon = "data:image/png;base64,Q0NDQw==";
    const previousIcon = "data:image/png;base64,QkJCQg==";

    recordFaviconForProject(
      TARGET_PROJECT,
      makeFaviconPayload("http://192.168.64.2:3000/", 10, previousIcon),
      "192.168.64.2",
    );
    recordFaviconForProject(
      TARGET_PROJECT,
      makeFaviconPayload("http://192.168.64.3:3000/", 20, updatedIcon),
      "192.168.64.3",
    );
    recordFaviconForProject(
      TARGET_PROJECT,
      makeFaviconPayload("http://192.168.64.4:3000/", 15, previousIcon),
      "192.168.64.4",
    );

    const storeState = useBrowserFaviconStore.getState().byKey;
    for (const hostIp of ["192.168.64.2", "192.168.64.3", "192.168.64.4"]) {
      expect(lookupFavicon(storeState, TARGET_PROJECT, `http://${hostIp}:3000/`, null)).toBe(
        updatedIcon,
      );
    }
    expect(storeState["host-alpha:proj-core http://localhost:3000"]?.capturedAt).toBe(20);
  });

  it("retrieves persisted IPv6 host favicon without online connection", () => {
    recordFaviconForProject(
      TARGET_PROJECT,
      makeFaviconPayload("http://[fd00::1]:3000/api", 5),
      "fd00::1",
    );

    const migrated = migrateSavedFavicons({
      byKey: useBrowserFaviconStore.getState().byKey,
    }).byKey;

    expect(lookupFavicon(migrated, TARGET_PROJECT, "http://[fd00::1]:3000/api", null)).toBe(
      SAMPLE_PNG,
    );
  });

  it("retrieves environment favicon after shell loads without live connection", () => {
    recordFaviconForProject(
      TARGET_PROJECT,
      makeFaviconPayload("http://192.168.64.2:3000/app", 5),
      "192.168.64.2",
    );

    const currentState = useBrowserFaviconStore.getState().byKey;

    expect(lookupFavicon(currentState, null, "http://localhost:3000/app", null)).toBeNull();
    expect(lookupFavicon(currentState, TARGET_PROJECT, "http://localhost:3000/app", null)).toBe(
      SAMPLE_PNG,
    );
    expect(lookupFavicon(currentState, TARGET_PROJECT, "http://192.168.64.2:3000/app", null)).toBe(
      SAMPLE_PNG,
    );
    expect(
      lookupFavicon(currentState, TARGET_PROJECT, "http://192.168.64.3:3000/app", null),
    ).toBeNull();
    expect(
      lookupFavicon(currentState, TARGET_PROJECT, "https://192.168.64.2:3000/app", null),
    ).toBeNull();
    expect(
      lookupFavicon(currentState, TARGET_PROJECT, "http://192.168.64.2:3001/app", null),
    ).toBeNull();

    const differentProject = hostProjectRef(PRIMARY_HOST, ProjectId.make("proj-other"));
    expect(
      lookupFavicon(currentState, differentProject, "http://192.168.64.2:3000/app", null),
    ).toBeNull();
  });

  it("maintains separation of localhost icons between distinct hosts and projects", () => {
    const altHostProj = hostProjectRef(HostId.make("host-beta"), ProjectId.make("proj-core"));
    const altProjOnSameHost = hostProjectRef(PRIMARY_HOST, ProjectId.make("proj-other"));

    recordFaviconForProject(TARGET_PROJECT, makeFaviconPayload("http://localhost:3000/", 1), null);
    recordFaviconForProject(altHostProj, makeFaviconPayload("http://localhost:3000/", 2), null);
    recordFaviconForProject(
      altProjOnSameHost,
      makeFaviconPayload("http://localhost:3000/", 3),
      null,
    );

    expect(Object.keys(useBrowserFaviconStore.getState().byKey)).toEqual([
      "host-alpha:proj-core http://localhost:3000",
      "host-beta:proj-core http://localhost:3000",
      "host-alpha:proj-other http://localhost:3000",
    ]);
  });

  it("retains newer capture for an origin while ignoring duplicate revisions", () => {
    const recordSpy = vi.spyOn(useBrowserFaviconStore.getState(), "recordFavicon");

    recordFaviconForProject(TARGET_PROJECT, makeFaviconPayload("http://localhost:3000/", 20), null);
    recordFaviconForProject(
      TARGET_PROJECT,
      makeFaviconPayload("http://localhost:3000/old", 10, "data:image/png;base64,QkJCQg=="),
      null,
    );
    recordFaviconForProject(
      TARGET_PROJECT,
      makeFaviconPayload("http://localhost:3000/new", 30),
      null,
    );
    recordFaviconForProject(
      TARGET_PROJECT,
      makeFaviconPayload("http://localhost:3000/new", 30),
      null,
    );

    expect(Object.values(useBrowserFaviconStore.getState().byKey)).toEqual([
      { dataUrl: SAMPLE_PNG, capturedAt: 30 },
    ]);
    expect(recordSpy).toHaveBeenCalledTimes(2);
  });
});
