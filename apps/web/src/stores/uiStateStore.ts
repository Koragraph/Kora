import { create } from "zustand";
import { Debouncer } from "@tanstack/react-pacer";
import type { MergeRequestMergeMethod } from "@kora/contracts";

import { canonicalProjectPath } from "../util/projectPaths";

export const PERSISTED_STATE_KEY = "kora:ui-state:v1";

const versionedKeys = (namespace: string, versions: readonly number[]): string[] =>
  versions.map((version) => `${namespace}:renderer-state:v${version}`);

const LEGACY_PERSISTED_STATE_KEYS: readonly string[] = [
  ...versionedKeys("kora", [8, 7, 6, 5, 4, 3]),
  ...versionedKeys("codething", [4, 3, 2, 1]),
];

// Marks "projects not listed were collapsed by default" in data migrated from the cwd lists.
const LEGACY_EXPANSION_DEFAULT_KEY = "legacy-project-expansion-default";
const CHANGED_FILES_EXPANSION_VERSION = 2;
const PERSIST_DELAY_MS = 500;

export interface PersistedUiState {
  pullRequestMergeMethod?: string;
  threadChangedFilesExpandedById?: Record<string, Record<string, boolean>>;
  threadChangedFilesExpansionVersion?: number;
  sidebarProjectScopeKey?: string | null;
  defaultAdvertisedEndpointKey?: string | null;
  projectOrderCwds?: string[];
  expandedProjectCwds?: string[];
  collapsedProjectCwds?: string[];
  threadLastVisitedAtById?: Record<string, string>;
  projectOrder?: string[];
  projectExpandedById?: Record<string, boolean>;
}

export interface UiProjectState {
  sidebarProjectScopeKey: string | null;
  projectOrder: string[];
  projectExpandedById: Record<string, boolean>;
}

export interface UiThreadState {
  threadChangedFilesExpandedById: Record<string, Record<string, boolean>>;
  threadLastVisitedAtById: Record<string, string>;
}

export interface UiEndpointState {
  defaultAdvertisedEndpointKey: null | string;
}

export interface UiMergeRequestState {
  pullRequestMergeMethod: MergeRequestMergeMethod;
}

export interface UiState
  extends UiProjectState, UiThreadState, UiEndpointState, UiMergeRequestState {}

const initialState: UiState = {
  pullRequestMergeMethod: "merge",
  defaultAdvertisedEndpointKey: null,
  threadChangedFilesExpandedById: {},
  threadLastVisitedAtById: {},
  sidebarProjectScopeKey: null,
  projectOrder: [],
  projectExpandedById: {},
};

export function legacyProjectCwdPreferenceKey(workDir: string): string {
  return `legacy-project-cwd:${canonicalProjectPath(workDir)}`;
}

// ---------- sanitising ----------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function cleanStrings(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return [
    ...new Set(
      val.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    ),
  ];
}

function cleanBooleans(val: unknown): Record<string, boolean> {
  const acc: Record<string, boolean> = {};
  if (!isRecord(val)) return acc;
  for (const [k, v] of Object.entries(val)) {
    if (k && typeof v === "boolean") acc[k] = v;
  }
  return acc;
}

const cleanKey = (val: unknown): string | null =>
  typeof val === "string" && val.length > 0 ? val : null;

const parsesAsTime = (val: string): boolean => Number.isFinite(Date.parse(val));

function cleanTimestamps(val: unknown): Record<string, string> {
  const acc: Record<string, string> = {};
  if (!isRecord(val)) return acc;
  for (const [k, v] of Object.entries(val)) {
    if (k && typeof v === "string" && parsesAsTime(v)) acc[k] = v;
  }
  return acc;
}

function cleanExpansion(val: unknown): Record<string, Record<string, boolean>> {
  const acc: Record<string, Record<string, boolean>> = {};
  if (!isRecord(val)) return acc;
  for (const [threadId, turns] of Object.entries(val)) {
    if (!threadId || !isRecord(turns)) continue;
    const retained = cleanBooleans(turns);
    if (Object.keys(retained).length > 0) acc[threadId] = retained;
  }
  return acc;
}

function migrateLegacyExpansion(decoded: PersistedUiState): Record<string, boolean> {
  const expansion: Record<string, boolean> = {};
  for (const workDir of cleanStrings(decoded.collapsedProjectCwds)) {
    expansion[legacyProjectCwdPreferenceKey(workDir)] = false;
  }
  const openFlag = cleanStrings(decoded.expandedProjectCwds);
  for (const workDir of openFlag) expansion[legacyProjectCwdPreferenceKey(workDir)] = true;
  if (!Array.isArray(decoded.collapsedProjectCwds) && openFlag.length > 0) {
    expansion[LEGACY_EXPANSION_DEFAULT_KEY] = false;
  }
  return expansion;
}

const MERGE_METHODS: ReadonlySet<string> = new Set(["merge", "squash", "rebase"]);

export function parsePersistedState(decoded: PersistedUiState): UiState {
  return {
    projectExpandedById:
      decoded.projectExpandedById === undefined
        ? migrateLegacyExpansion(decoded)
        : cleanBooleans(decoded.projectExpandedById),
    projectOrder:
      decoded.projectOrder === undefined
        ? cleanStrings(decoded.projectOrderCwds).map(legacyProjectCwdPreferenceKey)
        : cleanStrings(decoded.projectOrder),
    threadLastVisitedAtById: cleanTimestamps(decoded.threadLastVisitedAtById),
    // v1 recorded card visibility, not folder expansion, so it is never reused.
    threadChangedFilesExpandedById:
      decoded.threadChangedFilesExpansionVersion === CHANGED_FILES_EXPANSION_VERSION
        ? cleanExpansion(decoded.threadChangedFilesExpandedById)
        : {},
    defaultAdvertisedEndpointKey: cleanKey(decoded.defaultAdvertisedEndpointKey),
    sidebarProjectScopeKey: cleanKey(decoded.sidebarProjectScopeKey),
    pullRequestMergeMethod: MERGE_METHODS.has(decoded.pullRequestMergeMethod ?? "")
      ? (decoded.pullRequestMergeMethod as MergeRequestMergeMethod)
      : "merge",
  };
}

// ---------- storage ----------

function readPersistedState(): UiState {
  if (typeof window === "undefined") return initialState;
  try {
    let unparsed = window.localStorage.getItem(PERSISTED_STATE_KEY);
    for (const legacy of LEGACY_PERSISTED_STATE_KEYS) {
      if (unparsed) break;
      unparsed = window.localStorage.getItem(legacy);
    }
    return unparsed ? parsePersistedState(JSON.parse(unparsed) as PersistedUiState) : initialState;
  } catch {
    return initialState;
  }
}

let legacyKeysCleared = false;

export function persistState(state: UiState): void {
  if (typeof window === "undefined") return;
  try {
    const { [LEGACY_EXPANSION_DEFAULT_KEY]: _sentinel, ...expanded } = state.projectExpandedById;
    const payload = {
      pullRequestMergeMethod: state.pullRequestMergeMethod,
      threadChangedFilesExpandedById: state.threadChangedFilesExpandedById,
      threadChangedFilesExpansionVersion: CHANGED_FILES_EXPANSION_VERSION,
      sidebarProjectScopeKey: state.sidebarProjectScopeKey,
      defaultAdvertisedEndpointKey: state.defaultAdvertisedEndpointKey,
      threadLastVisitedAtById: state.threadLastVisitedAtById,
      projectOrder: state.projectOrder,
      projectExpandedById: expanded,
    } satisfies PersistedUiState;
    window.localStorage.setItem(PERSISTED_STATE_KEY, JSON.stringify(payload));
    if (!legacyKeysCleared) {
      legacyKeysCleared = true;
      for (const keyName of LEGACY_PERSISTED_STATE_KEYS) window.localStorage.removeItem(keyName);
    }
  } catch {
    /* storage unavailable or full */
  }
}

// ---------- pure transitions (same object back when nothing changes) ----------

export function markThreadVisited(state: UiState, threadKey: string, visitedAt: string): UiState {
  const upcoming = Date.parse(visitedAt);
  if (!Number.isFinite(upcoming)) return state;
  const prior = state.threadLastVisitedAtById[threadKey];
  if (prior !== undefined) {
    const earlier = Date.parse(prior);
    if (Number.isFinite(earlier) && earlier >= upcoming) return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: { ...state.threadLastVisitedAtById, [threadKey]: visitedAt },
  };
}

function seedThreadVisits(
  state: UiState,
  records: ReadonlyArray<readonly [string, string]>,
): UiState {
  const additions: Record<string, string> = {};
  for (const [threadId, visitedAt] of records) {
    if (state.threadLastVisitedAtById[threadId]) continue;
    if (parsesAsTime(visitedAt)) additions[threadId] = visitedAt;
  }
  if (Object.keys(additions).length === 0) return state;
  return { ...state, threadLastVisitedAtById: { ...state.threadLastVisitedAtById, ...additions } };
}

export function markThreadUnread(
  state: UiState,
  threadKey: string,
  latestTurnCompletedAt: string | null | undefined,
): UiState {
  if (!latestTurnCompletedAt) return state;
  const completed = Date.parse(latestTurnCompletedAt);
  if (!Number.isFinite(completed)) return state;
  // One millisecond before completion reads as "finished after you last looked".
  const stamp = new Date(completed - 1).toISOString();
  if (state.threadLastVisitedAtById[threadKey] === stamp) return state;
  return {
    ...state,
    threadLastVisitedAtById: { ...state.threadLastVisitedAtById, [threadKey]: stamp },
  };
}

export function setThreadChangedFilesExpanded(
  state: UiState,
  threadKey: string,
  turnId: string,
  openFlag: boolean,
): UiState {
  const turns = state.threadChangedFilesExpandedById[threadKey] ?? {};
  if (turns[turnId] === openFlag) return state;
  return {
    ...state,
    threadChangedFilesExpandedById: {
      ...state.threadChangedFilesExpandedById,
      [threadKey]: { ...turns, [turnId]: openFlag },
    },
  };
}

export function setDefaultAdvertisedEndpointKey(state: UiState, keyName: string | null): UiState {
  const upcoming = cleanKey(keyName);
  return state.defaultAdvertisedEndpointKey === upcoming
    ? state
    : { ...state, defaultAdvertisedEndpointKey: upcoming };
}

/** Held here (not in the sidebar) so Settings, which unmounts the sidebar, cannot reset it. */
export function setNavProjectScopeKey(state: UiState, projId: string | null): UiState {
  const upcoming = cleanKey(projId);
  return state.sidebarProjectScopeKey === upcoming
    ? state
    : { ...state, sidebarProjectScopeKey: upcoming };
}

function setMergeRequestMergeMethod(state: UiState, verb: MergeRequestMergeMethod): UiState {
  return state.pullRequestMergeMethod === verb ? state : { ...state, pullRequestMergeMethod: verb };
}

export function setProjectExpanded(
  ui: UiState,
  projectIds: string | readonly string[],
  openFlag: boolean,
): UiState {
  const ids = typeof projectIds === "string" ? [projectIds] : projectIds;
  const changed = ids.filter((projectId) => ui.projectExpandedById[projectId] !== openFlag);
  if (changed.length === 0) return ui;
  const projectExpandedById = { ...ui.projectExpandedById };
  for (const projectId of changed) projectExpandedById[projectId] = openFlag;
  return { ...ui, projectExpandedById };
}

export function reorderProjects(
  state: UiState,
  orderNow: readonly string[],
  movingIds: readonly string[],
  dropOnIds: readonly string[],
): UiState {
  if (movingIds.length === 0) return state;
  const targets = new Set(dropOnIds);
  if (movingIds.every((projectId) => targets.has(projectId))) return state;
  const anch = orderNow.findIndex((projectId) => targets.has(projectId));
  if (anch < 0) return state;

  const dragged = new Set(movingIds);
  const leftover: string[] = [];
  const lifted: string[] = [];
  let liftedBeforeAnchor = 0;
  orderNow.forEach((projectId, pos) => {
    if (dragged.has(projectId)) {
      lifted.push(projectId);
      if (pos < anch) liftedBeforeAnchor += 1;
    } else {
      leftover.push(projectId);
    }
  });
  if (lifted.length === 0) return state;

  const insertAt = anch - Math.max(0, liftedBeforeAnchor - 1);
  leftover.splice(insertAt, 0, ...lifted);
  return { ...state, projectOrder: leftover };
}

// ---------- store ----------

interface UiStateActions {
  reorderProjects: (
    orderNow: readonly string[],
    movingIds: readonly string[],
    dropOnIds: readonly string[],
  ) => void;
  setProjectExpanded: (projectIds: string | readonly string[], openFlag: boolean) => void;
  setMergeRequestMergeMethod: (verb: MergeRequestMergeMethod) => void;
  setNavProjectScopeKey: (projId: string | null) => void;
  setDefaultAdvertisedEndpointKey: (keyName: string | null) => void;
  setThreadChangedFilesExpanded: (threadKey: string, turnId: string, openFlag: boolean) => void;
  seedThreadVisits: (records: ReadonlyArray<readonly [string, string]>) => void;
  markThreadUnread: (threadKey: string, latestTurnCompletedAt: string | null | undefined) => void;
  markThreadVisited: (threadKey: string, visitedAt: string) => void;
}

export const useViewStateStore = create<UiState & UiStateActions>((bag) => ({
  ...readPersistedState(),
  markThreadVisited: (threadKey, visitedAt) =>
    bag((current) => markThreadVisited(current, threadKey, visitedAt)),
  markThreadUnread: (threadKey, when) =>
    bag((current) => markThreadUnread(current, threadKey, when)),
  seedThreadVisits: (records) => bag((current) => seedThreadVisits(current, records)),
  setThreadChangedFilesExpanded: (threadKey, turnId, openFlag) =>
    bag((current) => setThreadChangedFilesExpanded(current, threadKey, turnId, openFlag)),
  setDefaultAdvertisedEndpointKey: (keyName) =>
    bag((current) => setDefaultAdvertisedEndpointKey(current, keyName)),
  setNavProjectScopeKey: (projId) => bag((current) => setNavProjectScopeKey(current, projId)),
  setMergeRequestMergeMethod: (verb) => bag((current) => setMergeRequestMergeMethod(current, verb)),
  setProjectExpanded: (ids, openFlag) =>
    bag((current) => setProjectExpanded(current, ids, openFlag)),
  reorderProjects: (order, dragged, targets) =>
    bag((current) => reorderProjects(current, order, dragged, targets)),
}));

const persistDebouncer = new Debouncer(persistState, { wait: PERSIST_DELAY_MS });
useViewStateStore.subscribe((state) => persistDebouncer.maybeExecute(state));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => persistDebouncer.flush());
}
