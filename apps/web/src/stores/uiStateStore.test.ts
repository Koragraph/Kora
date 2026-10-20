import { ProjectId, ThreadId } from "@kora/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as uiStore from "./uiStateStore";

const { PERSISTED_STATE_KEY, markThreadUnread, markThreadVisited } = uiStore;

const { parsePersistedState, persistState, reorderProjects } = uiStore;

const {
  setDefaultAdvertisedEndpointKey,
  setNavProjectScopeKey,
  setProjectExpanded,
  setThreadChangedFilesExpanded,
} = uiStore;

type UiState = uiStore.UiState;
type PersistedUiState = uiStore.PersistedUiState;

function createBlankUiState(modifications: Partial<UiState> = {}): UiState {
  return {
    pullRequestMergeMethod: "merge",
    defaultAdvertisedEndpointKey: null,
    sidebarProjectScopeKey: null,
    threadChangedFilesExpandedById: {},
    projectOrder: [],
    threadLastVisitedAtById: {},
    projectExpandedById: {},
    ...modifications,
  };
}

describe("parsePersistedState validation and schema migration", () => {
  it.each([undefined, 1])(
    "discards changed file expansion records for legacy format version %s",
    (ver) => {
      const output = parsePersistedState({
        ...(ver !== undefined && { threadChangedFilesExpansionVersion: ver }),
        threadChangedFilesExpandedById: {
          "host:th-abc": { "step-1": false },
        },
      });

      expect(output.threadChangedFilesExpandedById).toEqual({});
    },
  );

  it("recovers UI preferences and cleans malformed records on parse", () => {
    const rawSaved = {
      defaultAdvertisedEndpointKey: "node-lan:http:3000",
      projectExpandedById: {
        corrupted: "not-bool" as unknown as boolean,
        logicalRoot: false,
      },
      projectOrder: ["proj-2", "", "proj-1", "proj-2"],
      pullRequestMergeMethod: "merge",
      threadChangedFilesExpandedById: {
        "host:th-1": { "step-1": false, "step-2": true },
      },
      threadChangedFilesExpansionVersion: 2,
      threadLastVisitedAtById: {
        "bad-key": "invalid-timestamp",
        "host:th-1": "2026-02-25T12:35:00.000Z",
      },
    };

    const hydrated = parsePersistedState(rawSaved);

    expect(hydrated).toEqual({
      defaultAdvertisedEndpointKey: "node-lan:http:3000",
      projectExpandedById: {
        logicalRoot: false,
      },
      projectOrder: ["proj-2", "proj-1"],
      pullRequestMergeMethod: "merge",
      sidebarProjectScopeKey: null,
      threadChangedFilesExpandedById: {
        "host:th-1": { "step-1": false, "step-2": true },
      },
      threadLastVisitedAtById: {
        "host:th-1": "2026-02-25T12:35:00.000Z",
      },
    });
  });

  it("defaults unrecognized pull request merge method to merge strategy", () => {
    const validSquash = parsePersistedState({
      pullRequestMergeMethod: "squash",
    });
    expect(validSquash.pullRequestMergeMethod).toBe("squash");

    const unsupportedMethod = parsePersistedState({
      pullRequestMergeMethod: "cherry-pick",
    });
    expect(unsupportedMethod.pullRequestMergeMethod).toBe("merge");
  });
});

describe("uiStateStore state transitions", () => {
  it("modifies navigation sidebar scope key with empty fallback to null", () => {
    const fresh = createBlankUiState();
    const updated = setNavProjectScopeKey(fresh, "org/repo-demo");

    expect(updated.sidebarProjectScopeKey).toBe("org/repo-demo");
    expect(setNavProjectScopeKey(updated, "org/repo-demo")).toBe(updated);

    const clearedNull = setNavProjectScopeKey(updated, null);
    expect(clearedNull.sidebarProjectScopeKey).toBeNull();

    const clearedEmpty = setNavProjectScopeKey(updated, "");
    expect(clearedEmpty.sidebarProjectScopeKey).toBeNull();
  });

  it("toggles default advertised endpoint key and strips empty string values", () => {
    const initial = createBlankUiState();
    const modified = setDefaultAdvertisedEndpointKey(initial, "host-main:http:8080");

    expect(modified.defaultAdvertisedEndpointKey).toBe("host-main:http:8080");
    expect(setDefaultAdvertisedEndpointKey(modified, "host-main:http:8080")).toBe(modified);

    const blanked = setDefaultAdvertisedEndpointKey(modified, "");
    expect(blanked.defaultAdvertisedEndpointKey).toBeNull();
  });

  it("records per-thread turn file expansion toggles", () => {
    const testThread = ThreadId.make("thread-alpha");
    const collapsed = setThreadChangedFilesExpanded(
      createBlankUiState(),
      testThread,
      "turn-10",
      false,
    );

    expect(collapsed.threadChangedFilesExpandedById).toEqual({
      [testThread]: { "turn-10": false },
    });

    const reExpanded = setThreadChangedFilesExpanded(collapsed, testThread, "turn-10", true);
    expect(reExpanded.threadChangedFilesExpandedById).toEqual({
      [testThread]: { "turn-10": true },
    });
  });

  it("no-ops reorder attempts targeting non-existent elements or identity moves", () => {
    const activeOrder = ["env-1:project-x", "env-1:project-y"];
    const base = createBlankUiState();

    expect(reorderProjects(base, activeOrder, ["env-1:unknown"], ["env-1:project-y"])).toBe(base);
    expect(reorderProjects(base, activeOrder, ["env-1:project-x"], ["env-1:project-x"])).toBe(base);
  });

  it("relocates project clusters preserving mutual relative positions", () => {
    const itemA1 = "env-local:proj-alpha";
    const itemA2 = "env-remote:proj-alpha";
    const itemB = "env-local:proj-beta";
    const itemC = "env-local:proj-gamma";
    const currentList = [itemA1, itemA2, itemB, itemC];

    const shifted = reorderProjects(createBlankUiState(), currentList, [itemA1, itemA2], [itemC]);
    expect(shifted.projectOrder).toEqual([itemB, itemC, itemA1, itemA2]);
  });

  it("reorders project sequences from derived atom arrangement", () => {
    const p1 = ProjectId.make("p-1");
    const p2 = ProjectId.make("p-2");
    const p3 = ProjectId.make("p-3");

    const reordered = reorderProjects(createBlankUiState(), [p1, p2, p3], [p1], [p3]);
    expect(reordered.projectOrder).toEqual([p2, p3, p1]);
  });

  it("applies expansion setting uniformly across mapped project keys", () => {
    const startingState = createBlankUiState();
    const projectIdentifiers = ["logical-key", "host-1:/workspace", "host-2:/workspace"];

    const collapsed = setProjectExpanded(startingState, projectIdentifiers, false);
    expect(collapsed.projectExpandedById).toEqual({
      "host-2:/workspace": false,
      "host-1:/workspace": false,
      "logical-key": false,
    });
    expect(setProjectExpanded(collapsed, projectIdentifiers, false)).toBe(collapsed);
  });

  it("rewinds thread last visited mark by 1ms to mark unread on turn finish", () => {
    const th = ThreadId.make("thread-unread-test");
    const prior = createBlankUiState({
      threadLastVisitedAtById: { [th]: "2026-03-01T10:00:00.000Z" },
    });

    const flagged = markThreadUnread(prior, th, "2026-03-01T09:30:00.000Z");
    expect(flagged.threadLastVisitedAtById[th]).toBe("2026-03-01T09:29:59.999Z");
    expect(markThreadUnread(flagged, th, null)).toBe(flagged);
  });

  it("advances thread last visited timestamp monotonically while ignoring older timestamps", () => {
    const targetTh = ThreadId.make("thread-monotone-test");
    const initial = createBlankUiState();

    const visitedNew = markThreadVisited(initial, targetTh, "2026-03-01T10:15:00.500Z");
    expect(visitedNew.threadLastVisitedAtById[targetTh]).toBe("2026-03-01T10:15:00.500Z");

    const olderAttempt = markThreadVisited(visitedNew, targetTh, "2026-03-01T10:00:00.000Z");
    expect(olderAttempt).toBe(visitedNew);

    const corruptAttempt = markThreadVisited(visitedNew, targetTh, "not-a-valid-iso-date");
    expect(corruptAttempt).toBe(visitedNew);
  });
});

function buildStorageMock(): Storage {
  const dictionary = new Map<string, string>();
  return {
    clear() {
      dictionary.clear();
    },
    getItem(key: string) {
      return dictionary.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(dictionary.keys())[index] ?? null;
    },
    get length() {
      return dictionary.size;
    },
    removeItem(key: string) {
      dictionary.delete(key);
    },
    setItem(key: string, val: string) {
      dictionary.set(key, val);
    },
  };
}

describe("uiStateStore localStorage integration", () => {
  let diskStorage: Storage;

  beforeEach(() => {
    diskStorage = buildStorageMock();
    vi.stubGlobal("window", { localStorage: diskStorage });
    vi.stubGlobal("localStorage", diskStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves and retrieves sidebarProjectScopeKey through persistence roundtrip", () => {
    const state = createBlankUiState({ sidebarProjectScopeKey: "koraplex/dev-tools" });
    persistState(state);

    const rawJson = diskStorage.getItem(PERSISTED_STATE_KEY);
    const deserialized = JSON.parse(rawJson ?? "{}") as PersistedUiState;

    expect(parsePersistedState(deserialized).sidebarProjectScopeKey).toBe("koraplex/dev-tools");
  });

  it("serializes full collection of UI preferences into persistent store", () => {
    const sample = createBlankUiState({
      defaultAdvertisedEndpointKey: "dev-machine:http:5000",
      projectExpandedById: { mainRepo: false },
      projectOrder: ["proj-b", "proj-a"],
      threadChangedFilesExpandedById: {
        "env:th-9": { "turn-1": false, "turn-2": true },
      },
      threadLastVisitedAtById: {
        "env:th-9": "2026-02-25T12:35:00.000Z",
      },
    });

    persistState(sample);

    const rawBlob = diskStorage.getItem(PERSISTED_STATE_KEY);
    const parsedStored = JSON.parse(rawBlob ?? "{}") as PersistedUiState;

    expect(parsedStored).toEqual({
      defaultAdvertisedEndpointKey: "dev-machine:http:5000",
      projectExpandedById: { mainRepo: false },
      projectOrder: ["proj-b", "proj-a"],
      pullRequestMergeMethod: "merge",
      sidebarProjectScopeKey: null,
      threadChangedFilesExpandedById: {
        "env:th-9": { "turn-1": false, "turn-2": true },
      },
      threadChangedFilesExpansionVersion: 2,
      threadLastVisitedAtById: {
        "env:th-9": "2026-02-25T12:35:00.000Z",
      },
    });

    expect(parsePersistedState(parsedStored)).toEqual(sample);
  });
});
