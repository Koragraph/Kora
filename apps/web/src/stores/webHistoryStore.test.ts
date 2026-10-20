import { HostId, ThreadId } from "@kora/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { readPreparedLink } = vi.hoisted(() => ({
  readPreparedLink: vi.fn<() => { httpBaseUrl: string } | null>(() => null),
}));

vi.mock("~/atoms/session", () => ({ readPreparedLink }));

import * as webHistory from "./webHistoryStore";
type BrowserHistoryEntry = webHistory.BrowserHistoryEntry;

const { useBrowserHistoryStore, resetBrowserHistoryForTests } = webHistory;
const { rememberThreadVisit, setTitleForThreadUrl, removeUrlForThread } = webHistory;
const { migratePersistedBrowserHistoryState, mergeBrowserHistoryState } = webHistory;
const { upsertHistoryEntry, evictExcessProjects, normalizeHistoryUrl } = webHistory;
const {
  BROWSER_HISTORY_MAX_TITLE_LENGTH: MAX_TITLE_LEN,
  BROWSER_HISTORY_MAX_PROJECTS: MAX_PROJECTS,
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT: MAX_ENTRIES_PER_PROJ,
} = webHistory;

function buildHistoryItem(patch: Partial<BrowserHistoryEntry> = {}): BrowserHistoryEntry {
  return {
    url: "http://localhost:3000/",
    lastVisitedAt: 1000,
    ...patch,
  };
}

function captureStorageWriteSpy() {
  const persistOpts = useBrowserHistoryStore.persist.getOptions();
  const disk = persistOpts.storage;
  if (!disk) {
    throw new Error("Missing storage engine on history store");
  }
  return vi.spyOn(disk, "setItem");
}

const defaultThreadContext = {
  hostId: HostId.make("host-worker-1"),
  threadId: ThreadId.make("th-test-session"),
};

beforeEach(() => {
  readPreparedLink.mockReturnValue(null);
  resetBrowserHistoryForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("migratePersistedBrowserHistoryState persistence validation", () => {
  it("clips excessively long titles at the specified maximum boundary", () => {
    const hugeTitle = "T".repeat(MAX_TITLE_LEN + 80);
    const result = migratePersistedBrowserHistoryState({
      byProjectKey: {
        "p-target": [{ url: "http://example.internal/", lastVisitedAt: 50, title: hugeTitle }],
      },
    });

    const storedTitle = result.byProjectKey["p-target"]?.[0]?.title;
    expect(storedTitle?.length).toBe(MAX_TITLE_LEN);
    expect(storedTitle).toBe(hugeTitle.slice(0, MAX_TITLE_LEN));
  });

  it("filters out records with timestamps out of acceptable Date boundaries", () => {
    const migration = migratePersistedBrowserHistoryState({
      byProjectKey: {
        "p-main": [
          { url: "http://valid.test/", lastVisitedAt: 1500 },
          { url: "http://overflow.test/", lastVisitedAt: 9e22 },
        ],
      },
    });

    expect(migration.byProjectKey["p-main"]).toEqual([
      { url: "http://valid.test/", lastVisitedAt: 1500 },
    ]);
  });

  it("restores records ordered by visit recency, merges duplicates, and limits project count", () => {
    const rawProjects: Record<string, BrowserHistoryEntry[]> = {};
    for (let idx = 0; idx <= MAX_PROJECTS; idx++) {
      rawProjects[`bucket-${idx}`] = [
        { url: `http://bucket-${idx}.test/`, lastVisitedAt: idx * 10 },
      ];
    }

    rawProjects["bucket-1"] = [
      { url: "https://site.org/", lastVisitedAt: 200 },
      { url: "http://recent.org/", lastVisitedAt: 400 },
      { url: "site.org/", lastVisitedAt: 100 },
    ];

    const migrated = migratePersistedBrowserHistoryState({ byProjectKey: rawProjects });

    const retainedKeys = Object.keys(migrated.byProjectKey);
    expect(retainedKeys.length).toBe(MAX_PROJECTS);
    expect(migrated.byProjectKey["bucket-0"]).toBeUndefined();
    expect(migrated.byProjectKey["bucket-1"]).toEqual([
      { url: "http://recent.org/", lastVisitedAt: 400 },
      { url: "https://site.org/", lastVisitedAt: 200 },
    ]);
  });

  it("applies URL canonicalization rules identically to input migration", () => {
    const res = migratePersistedBrowserHistoryState({
      byProjectKey: {
        workspace: [{ url: "demo.internal/page#subheading", lastVisitedAt: 800 }],
      },
    });

    expect(res.byProjectKey["workspace"]).toEqual([
      { url: "https://demo.internal/page#subheading", lastVisitedAt: 800 },
    ]);
  });

  it("resets gracefully when receiving undefined, null, or garbage serialized shapes", () => {
    expect(migratePersistedBrowserHistoryState(undefined)).toEqual({ byProjectKey: {} });
    expect(migratePersistedBrowserHistoryState("invalid-string")).toEqual({ byProjectKey: {} });
    expect(migratePersistedBrowserHistoryState({ byProjectKey: 999 })).toEqual({
      byProjectKey: {},
    });

    const filtered = migratePersistedBrowserHistoryState({
      byProjectKey: {
        garbageProject: null,
        healthyProject: [
          { url: "http://valid.org/", lastVisitedAt: 200, title: "Healthy" },
          { url: "", lastVisitedAt: 200 },
          { url: "ftp://remote.host/", lastVisitedAt: 200 },
          { url: "http://bad-date.org/", lastVisitedAt: Number.NaN },
          false,
        ],
      },
    });

    expect(filtered.byProjectKey["garbageProject"]).toBeUndefined();
    expect(filtered.byProjectKey["healthyProject"]).toEqual([
      { url: "http://valid.org/", lastVisitedAt: 200, title: "Healthy" },
    ]);
  });
});

describe("evictExcessProjects capacity pruning", () => {
  it("drops oldest projects by activity when total project count exceeds configured limit", () => {
    const overflowMap: Record<string, BrowserHistoryEntry[]> = {};
    const totalCount = MAX_PROJECTS + 2;

    for (let i = 0; i < totalCount; i++) {
      overflowMap[`proj-${i}`] = [buildHistoryItem({ lastVisitedAt: i * 50 })];
    }

    const pruned = evictExcessProjects(overflowMap);
    expect(Object.keys(pruned)).toHaveLength(MAX_PROJECTS);
    expect(pruned["proj-0"]).toBeUndefined();
    expect(pruned["proj-1"]).toBeUndefined();
    expect(pruned[`proj-${totalCount - 1}`]).toBeDefined();
  });
});

describe("upsertHistoryEntry list management", () => {
  it("avoids updating visit timestamp when insertOrdered encounters older timestamp for existing entry", () => {
    const original = [buildHistoryItem({ url: "http://page.org/", lastVisitedAt: 5000 })];
    const outcome = upsertHistoryEntry(original, "http://page.org/", 2000, {
      insertOrdered: true,
    });

    expect(outcome).toEqual([{ url: "http://page.org/", lastVisitedAt: 5000 }]);
  });

  it("places entry in sorted order by visit timestamp when insertOrdered is true", () => {
    const initial = [buildHistoryItem({ url: "http://newest.org/", lastVisitedAt: 8000 })];
    const outcome = upsertHistoryEntry(initial, "http://older.org/", 3000, {
      insertOrdered: true,
    });

    expect(outcome.map((x) => x.url)).toEqual(["http://newest.org/", "http://older.org/"]);
  });

  it("enforces entry ceiling per project by discarding oldest elements", () => {
    const maxEntries = Array.from({ length: MAX_ENTRIES_PER_PROJ }, (_, k) =>
      buildHistoryItem({ url: `http://node-${k}.local/`, lastVisitedAt: k + 1 }),
    );

    const updated = upsertHistoryEntry(maxEntries, "http://brand-new.org/", 99999);
    expect(updated).toHaveLength(MAX_ENTRIES_PER_PROJ);
    expect(updated[0]?.url).toBe("http://brand-new.org/");

    const evictedHost = `http://node-${MAX_ENTRIES_PER_PROJ - 1}.local/`;
    expect(updated.some((e) => e.url === evictedHost)).toBe(false);
    expect(updated.some((e) => e.url === "http://node-0.local/")).toBe(true);
  });

  it("promotes revisited items to head, updates timestamp, and preserves existing title", () => {
    const existingList = [
      buildHistoryItem({ url: "http://first.dev/", lastVisitedAt: 100, title: "First Title" }),
      buildHistoryItem({ url: "http://second.dev/", lastVisitedAt: 50 }),
    ];

    const res = upsertHistoryEntry(existingList, "http://second.dev/", 600);
    expect(res.map((item) => item.url)).toEqual(["http://second.dev/", "http://first.dev/"]);
    expect(res[0]?.lastVisitedAt).toBe(600);
    expect(res[1]?.title).toBe("First Title");
  });

  it("inserts unfamiliar URLs at front of array with new timestamp", () => {
    const seed = [buildHistoryItem({ url: "http://alpha.dev/", lastVisitedAt: 10 })];
    const nextList = upsertHistoryEntry(seed, "http://beta.dev/", 90);

    expect(nextList.map((x) => x.url)).toEqual(["http://beta.dev/", "http://alpha.dev/"]);
    expect(nextList[0]).toEqual({ url: "http://beta.dev/", lastVisitedAt: 90 });
  });
});

describe("normalizeHistoryUrl parser and sanitization", () => {
  it("discards unsupported schemes, empty inputs, and strings exceeding max size", () => {
    expect(normalizeHistoryUrl("ftp://file.repo/doc")).toBeNull();
    expect(normalizeHistoryUrl("   ")).toBeNull();
    expect(normalizeHistoryUrl(`http://host.org/${"z".repeat(2048)}`)).toBeNull();
  });

  it("retains URL hash parameters while stripping userinfo authentication tokens", () => {
    expect(normalizeHistoryUrl("http://localhost:8080/dashboard#/overview")).toBe(
      "http://localhost:8080/dashboard#/overview",
    );
    expect(normalizeHistoryUrl("https://admin:pass123@secure.service/path")).toBe(
      "https://secure.service/path",
    );
  });

  it("prefixes bare domain references with https scheme", () => {
    expect(normalizeHistoryUrl("production.cloud")).toBe("https://production.cloud/");
  });

  it("defaults local development addresses to http scheme and keeps query strings", () => {
    expect(normalizeHistoryUrl("localhost:4000/metrics?format=json")).toBe(
      "http://localhost:4000/metrics?format=json",
    );
  });
});

describe("mergeBrowserHistoryState hydration handler", () => {
  it("cleans up invalid entries while maintaining action handlers across hydration", () => {
    const liveStore = useBrowserHistoryStore.getState();
    const hydrated = mergeBrowserHistoryState(
      {
        projectKeyByThreadKey: { active: "proj-1", stale: "proj-2", corrupt: 100 },
        byProjectKey: {
          "proj-1": [{ url: "http://valid-site.io/", lastVisitedAt: 55 }],
          "proj-2": [{ url: "ftp://bad-scheme.io/", lastVisitedAt: 12 }],
        },
      },
      liveStore,
    );

    expect(hydrated.byProjectKey).toEqual({
      "proj-1": [{ url: "http://valid-site.io/", lastVisitedAt: 55 }],
    });
    expect(typeof hydrated.recordVisit).toBe("function");
    expect(hydrated.projectKeyByThreadKey).toEqual({ active: "proj-1" });
    expect(hydrated.pendingVisitsByThreadKey).toEqual({});
    expect(hydrated.pendingTitlesByThreadKey).toEqual({});
  });
});

describe("pendingTitlesByThreadKey buffering mechanics", () => {
  it("resolves title against remote environment host when matched", () => {
    rememberThreadVisit(defaultThreadContext, "http://localhost:5173/admin", 10);
    setTitleForThreadUrl(
      defaultThreadContext,
      "http://192.168.64.2:5173/admin",
      "Admin Panel",
      "192.168.64.2",
    );

    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "p-admin");
    const resultEntries = useBrowserHistoryStore.getState().byProjectKey["p-admin"];
    expect(resultEntries?.[0]?.title).toBe("Admin Panel");
  });

  it("holds title staged prior to project binding and commits upon thread registration", () => {
    rememberThreadVisit(defaultThreadContext, "http://landing.app/", 15);
    setTitleForThreadUrl(defaultThreadContext, "http://landing.app/", "Landing Page");
    expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({});

    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "p-landing");

    const entries = useBrowserHistoryStore.getState().byProjectKey["p-landing"];
    expect(entries?.[0]).toMatchObject({ url: "http://landing.app/", title: "Landing Page" });
    expect(useBrowserHistoryStore.getState().pendingTitlesByThreadKey).toEqual({});
  });
});

describe("pendingVisitsByThreadKey buffer processing", () => {
  it("maintains chronological position when historical visits replay", () => {
    const alternateThread = {
      hostId: HostId.make("host-worker-2"),
      threadId: ThreadId.make("th-alt-session"),
    };

    useBrowserHistoryStore.getState().registerThreadProject(alternateThread, "shared-proj");
    rememberThreadVisit(alternateThread, "http://latest-item.io/", 3000);
    rememberThreadVisit(defaultThreadContext, "http://prior-item.io/", 1000);

    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "shared-proj");

    const stored = useBrowserHistoryStore.getState().byProjectKey["shared-proj"];
    expect(stored?.map((s) => s.url)).toEqual(["http://latest-item.io/", "http://prior-item.io/"]);
    expect(stored?.[0]?.lastVisitedAt).toBe(3000);
  });

  it("restricts queued pending visits buffer to 10 entries dropping oldest first", () => {
    for (let seq = 0; seq < 14; seq++) {
      rememberThreadVisit(defaultThreadContext, `http://step.io/${seq}`, seq);
    }

    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "p-seq");
    const savedUrls = useBrowserHistoryStore.getState().byProjectKey["p-seq"]?.map((e) => e.url);

    expect(savedUrls).toHaveLength(10);
    expect(savedUrls).not.toContain("http://step.io/0");
    expect(savedUrls).not.toContain("http://step.io/1");
    expect(savedUrls?.[0]).toBe("http://step.io/13");
  });

  it("stages recorded visits ahead of project registration and flushes on registration", () => {
    rememberThreadVisit(defaultThreadContext, "http://site-a.net/", 100);
    rememberThreadVisit(defaultThreadContext, "http://site-b.net/", 200);

    expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({});

    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "p-net");

    const recorded = useBrowserHistoryStore.getState().byProjectKey["p-net"];
    expect(recorded?.map((r) => r.url)).toEqual(["http://site-b.net/", "http://site-a.net/"]);
    expect(recorded?.[0]?.lastVisitedAt).toBe(200);
    expect(recorded?.[1]?.lastVisitedAt).toBe(100);
    expect(useBrowserHistoryStore.getState().pendingVisitsByThreadKey).toEqual({});
  });
});

describe("useBrowserHistoryStore store actions", () => {
  it("deletes specified history entry", () => {
    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "proj-rem");
    rememberThreadVisit(defaultThreadContext, "http://rem-1.dev/", 10);
    rememberThreadVisit(defaultThreadContext, "http://rem-2.dev/", 20);

    removeUrlForThread(defaultThreadContext, "http://rem-1.dev/");

    const items = useBrowserHistoryStore.getState().byProjectKey["proj-rem"]?.map((e) => e.url);
    expect(items).toEqual(["http://rem-2.dev/"]);
  });

  it("truncates live set titles exceeding maximum allowed length", () => {
    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "proj-trunc");
    rememberThreadVisit(defaultThreadContext, "http://target.dev/", 100);

    const longTitle = "Z".repeat(MAX_TITLE_LEN + 75);
    setTitleForThreadUrl(defaultThreadContext, "http://target.dev/", longTitle);

    const currentTitle = useBrowserHistoryStore.getState().byProjectKey["proj-trunc"]?.[0]?.title;
    expect(currentTitle).toHaveLength(MAX_TITLE_LEN);
    expect(currentTitle).toBe(longTitle.slice(0, MAX_TITLE_LEN));
  });

  it("targets exclusively the most recent entry when multiple items differ only by trailing slash", () => {
    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "proj-slash");
    rememberThreadVisit(defaultThreadContext, "http://domain.test/feed/", 10);
    rememberThreadVisit(defaultThreadContext, "http://domain.test/feed", 20);

    setTitleForThreadUrl(defaultThreadContext, "http://domain.test/feed/", "Feed Title");

    const items = useBrowserHistoryStore.getState().byProjectKey["proj-slash"];
    expect(items?.[0]).toMatchObject({ url: "http://domain.test/feed", title: "Feed Title" });
    expect(items?.[1]).toMatchObject({ url: "http://domain.test/feed/" });
    expect(items?.[1]?.title).toBeUndefined();
  });

  it("leaves title untouched when paths diverge beyond trailing slash variation", () => {
    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "proj-diverge");
    rememberThreadVisit(defaultThreadContext, "http://domain.test/feed", 10);

    setTitleForThreadUrl(defaultThreadContext, "http://domain.test/feed/extra", "Extra Title");

    const items = useBrowserHistoryStore.getState().byProjectKey["proj-diverge"];
    expect(items?.[0]?.title).toBeUndefined();
  });

  it("aliases local addresses and resolved environment host together", () => {
    readPreparedLink.mockReturnValue({ httpBaseUrl: "http://192.168.64.2:3773" });
    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "p-alias");

    rememberThreadVisit(defaultThreadContext, "http://localhost:5173/webapp", 1);
    rememberThreadVisit(defaultThreadContext, "http://127.0.0.1:5173/webapp", 2);
    rememberThreadVisit(defaultThreadContext, "http://192.168.64.2:5173/webapp", 3);

    expect(useBrowserHistoryStore.getState().byProjectKey["p-alias"]).toEqual([
      { url: "http://localhost:5173/webapp", lastVisitedAt: 3 },
    ]);

    useBrowserHistoryStore.setState({ byProjectKey: {} });
    rememberThreadVisit(defaultThreadContext, "http://192.168.64.2:5173/webapp", 4);
    rememberThreadVisit(defaultThreadContext, "http://localhost:5173/webapp", 5);

    expect(useBrowserHistoryStore.getState().byProjectKey["p-alias"]).toEqual([
      { url: "http://localhost:5173/webapp", lastVisitedAt: 5 },
    ]);
  });

  it("correlates localhost target with resolved environment host argument", () => {
    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "p-resolve");
    rememberThreadVisit(defaultThreadContext, "http://localhost:5173/page", 1);

    setTitleForThreadUrl(
      defaultThreadContext,
      "http://192.168.64.2:5173/page",
      "Page Title",
      "192.168.64.2",
    );

    const saved = useBrowserHistoryStore.getState().byProjectKey["p-resolve"]?.[0];
    expect(saved?.title).toBe("Page Title");
  });

  it("attaches title even if target URL has differing trailing slash", () => {
    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "p-slash-match");
    rememberThreadVisit(defaultThreadContext, "http://domain.test/docs", 1);

    setTitleForThreadUrl(defaultThreadContext, "http://domain.test/docs/", "Docs Title");
    expect(useBrowserHistoryStore.getState().byProjectKey["p-slash-match"]?.[0]).toMatchObject({
      title: "Docs Title",
      url: "http://domain.test/docs",
    });

    useBrowserHistoryStore.setState({ byProjectKey: {} });
    rememberThreadVisit(defaultThreadContext, "http://domain.test/docs/", 2);
    setTitleForThreadUrl(defaultThreadContext, "http://domain.test/docs", "Docs Title");
    expect(useBrowserHistoryStore.getState().byProjectKey["p-slash-match"]?.[0]).toMatchObject({
      title: "Docs Title",
      url: "http://domain.test/docs/",
    });
  });

  it("skips writing to persistent storage when new title matches existing title", () => {
    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "p-idempotent");
    rememberThreadVisit(defaultThreadContext, "http://static.dev/", 1);
    setTitleForThreadUrl(defaultThreadContext, "http://static.dev/", "Unchanged");

    const storageSpy = captureStorageWriteSpy();
    const currentState = useBrowserHistoryStore.getState().byProjectKey;

    setTitleForThreadUrl(defaultThreadContext, "http://static.dev/", "Unchanged");

    expect(useBrowserHistoryStore.getState().byProjectKey).toBe(currentState);
    expect(storageSpy).not.toHaveBeenCalled();
  });

  it("operates in update-only mode when setting titles through thread helper", () => {
    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "p-up-only");
    setTitleForThreadUrl(defaultThreadContext, "http://unknown.test/", "Ghost");
    expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({});

    rememberThreadVisit(defaultThreadContext, "http://known.test/#/home", 10);
    setTitleForThreadUrl(defaultThreadContext, "http://known.test/#/home", "Home");
    expect(useBrowserHistoryStore.getState().byProjectKey["p-up-only"]?.[0]?.title).toBe("Home");
  });

  it("discards illegal URLs whether encountered in pending buffer or post-registration", () => {
    rememberThreadVisit(defaultThreadContext, "ftp://blocked.org/", 1);
    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "p-discard");
    rememberThreadVisit(defaultThreadContext, "ftp://blocked.org/", 2);

    expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({});
  });

  it("avoids saving when registering a thread already mapped to same project", () => {
    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "p-dup");
    const diskSpy = captureStorageWriteSpy();

    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "p-dup");
    expect(diskSpy).not.toHaveBeenCalled();
  });

  it("persists visits for registered threads indexed under project key", () => {
    useBrowserHistoryStore.getState().registerThreadProject(defaultThreadContext, "p-live");
    rememberThreadVisit(defaultThreadContext, "portal.app/account#billing", 9876);

    expect(useBrowserHistoryStore.getState().byProjectKey["p-live"]).toEqual([
      { url: "https://portal.app/account#billing", lastVisitedAt: 9876 },
    ]);
  });
});
