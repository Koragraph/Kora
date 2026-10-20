import {
  getThreadSortTimestamp,
  toSortableTimestamp,
  type ThreadSortInput,
  sortThreads,
} from "../util/threadSort";
import type { NavThreadSummary, Thread } from "../types";
import { threadMergeRequestSearchTerms } from "@kora/shared/threadMergeRequests";
import type { NavProjectSortOrder, NavThreadSortOrder } from "@kora/contracts/clientPrefs";

export {
  sortActiveThreadsByOrderKey as sortThreadsForSidebar,
  pinOrderKeyBetween,
  planPinnedReorder,
  sortPinnedThreadsByOrderKey as sortPinnedThreadsForSidebar,
} from "@kora/client-runtime/store/thread-sort";

// Rows and section markers share one sortable list. Thread ids are scoped thread keys (they always contain a
// colon); marker ids use a colon-free prefix. Pinned and active threads keep a dragged position, settled threads
// follow time order. Snoozed rows may leave the shelf but are never a drop target (snoozing needs a wake time).
// "pinned-header" doubles as the landing target while nothing is pinned; placeholders give an empty section a
// place for the gap to open.
export type NavSection = "pinned" | "active" | "snoozed" | "settled";
export type NavListMarker =
  | "settled-placeholder"
  | "active-placeholder"
  | "snoozed-header"
  | "settled-header"
  | "pinned-divider"
  | "pinned-header";
export type NavListItem =
  | { readonly kind: "thread"; readonly key: string; readonly section: NavSection }
  | { readonly kind: "marker"; readonly marker: NavListMarker };
export type NavDropTarget = {
  readonly section: "settled" | "pinned" | "active";
  readonly pinnedOrder: readonly string[];
  readonly activeOrder: readonly string[];
};
export type NavThreadDropPlan =
  | { kind: "none" }
  | {
      kind: "reorder-pinned";
      order: readonly string[];
      assignments: ReadonlyArray<{ id: string; orderKey: string }>;
    }
  | {
      kind: "pin";
      order: readonly string[];
      orderKey: string | undefined;
      extraAssignments: ReadonlyArray<{ id: string; orderKey: string }>;
    }
  | {
      kind: "move-active";
      order: readonly string[];
      assignments: ReadonlyArray<{ id: string; orderKey: string }>;
      unpin: boolean;
      unsettle: boolean;
      unsnooze: boolean;
    }
  | { kind: "settle" };
export type NavDropVerb = "pin" | "unpin" | "settle" | "unsettle" | "wake";
export type ThreadTraversalDirection = "previous" | "next";

export interface ThreadStatusPill {
  pulse: boolean;
  dotClass: string;
  colorClass: string;
  label:
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready"
    | "Monitoring"
    | "Connecting"
    | "Completed"
    | "Working";
}

type ThreadStatusInput = Pick<
  NavThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingUserInput"
  | "hasPendingApprovals"
  | "backgroundLiveness"
  | "interactionMode"
  | "latestTurn"
  | "session"
> & { lastVisitedAt?: string | undefined };

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  const completedAt = thread.latestTurn?.completedAt;
  if (!completedAt) return false;
  const completedMs = Date.parse(completedAt);
  if (Number.isNaN(completedMs)) return false;
  if (!thread.lastVisitedAt) return false;
  const visitedMs = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(visitedMs)) return true;
  return completedMs > visitedMs;
}

/** The second click of a double-click must not run the row's navigation, or double-click-to-rename would navigate. */
export function isTrailingDoubleClick(detail: number): boolean {
  return detail > 1;
}

export function orderByPreferredIds<TItem, TId>(input: {
  getPreferenceIds?: (item: TItem) => readonly TId[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
  items: readonly TItem[];
}): TItem[] {
  const { items, preferredIds, getId, getPreferenceIds } = input;
  if (preferredIds.length === 0) return [...items];

  const indexesById = new Map<TId, number[]>();
  items.forEach((item, index) => {
    const ids = new Set(getPreferenceIds ? getPreferenceIds(item) : [getId(item)]);
    for (const id of ids) {
      const list = indexesById.get(id);
      if (list) list.push(index);
      else indexesById.set(id, [index]);
    }
  });

  const taken = new Set<number>();
  const result: TItem[] = [];
  for (const id of preferredIds) {
    const index = indexesById.get(id)?.find((candidate) => !taken.has(candidate));
    if (index === undefined) continue;
    taken.add(index);
    result.push(items[index]!);
  }
  items.forEach((item, index) => {
    if (!taken.has(index)) result.push(item);
  });
  return result;
}

export type NavThreadStatus = "approval" | "input" | "working" | "monitoring" | "failed" | "ready";

/**
 * Colour is reserved for act-now (approval), in motion (working) and broken (failed); "ready" is the quiet resting
 * state. An error outranks lingering background liveness so the failure is never hidden.
 */
export function resolveNavThreadStatus(
  thread: Pick<NavThreadSummary, "hasPendingApprovals" | "hasPendingUserInput" | "session"> &
    Partial<Pick<NavThreadSummary, "backgroundLiveness">>,
): NavThreadStatus {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  const sessionStatus = thread.session?.status;
  if (sessionStatus === "running" || sessionStatus === "starting") return "working";
  if (sessionStatus === "error") return "failed";
  if (thread.backgroundLiveness === "working") return "working";
  if (thread.backgroundLiveness === "monitoring") return "monitoring";
  return "ready";
}

export interface NavProjectScopeMenuState {
  readonly open: boolean;
  readonly query: string;
}
export type NavProjectScopeMenuAction =
  | { type: "query-changed"; query: string }
  | { type: "open-changed"; open: boolean }
  | { type: "project-settings-opened" };

export function searchNavThreads<
  T extends { readonly title: string } & Parameters<typeof threadMergeRequestSearchTerms>[0],
>(threads: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  return threads.filter(
    (thread) =>
      thread.title.toLowerCase().includes(needle) ||
      threadMergeRequestSearchTerms(thread).some((term) => term.toLowerCase().includes(needle)),
  );
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "updatedAt" | "projectId" | "createdAt" | "id"> & ThreadSortInput,
>(input: {
  deletedThreadIds?: ReadonlySet<T["id"]>;
  sortOrder: NavThreadSortOrder;
  deletedThreadId: T["id"];
  threads: readonly T[];
}): T["id"] | null {
  const deleted = input.threads.find((thread) => thread.id === input.deletedThreadId);
  if (!deleted) return null;
  const candidates = input.threads.filter(
    (thread) =>
      thread.projectId === deleted.projectId &&
      thread.id !== input.deletedThreadId &&
      !input.deletedThreadIds?.has(thread.id),
  );
  return sortThreads(candidates, input.sortOrder)[0]?.id ?? null;
}

export function sortScopedProjectsForNav<
  TProject extends {
    id: string;
    title: string;
    createdAt?: string;
    updatedAt?: string;
    hostId: string;
  },
  TThread extends ThreadSortInput & {
    hostId: string;
    projectId: string;
    archivedAt: string | null;
  },
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: NavProjectSortOrder,
): TProject[] {
  if (sortOrder === "manual") return [...projects];

  // Project ids are only unique per host. Archived threads must not make a project look recently active.
  const keyOf = (hostId: string, projectId: string) => `${hostId}\u0000${projectId}`;
  const byProject = new Map<string, TThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const key = keyOf(thread.hostId, thread.projectId);
    const list = byProject.get(key);
    if (list) list.push(thread);
    else byProject.set(key, [thread]);
  }

  const timestampOf = (project: TProject): number => {
    const own = byProject.get(keyOf(project.hostId, project.id));
    if (own && own.length > 0) {
      return Math.max(...own.map((thread) => getThreadSortTimestamp(thread, sortOrder)));
    }
    const iso =
      sortOrder === "created_at" ? project.createdAt : (project.updatedAt ?? project.createdAt);
    return toSortableTimestamp(iso) ?? Number.NEGATIVE_INFINITY;
  };

  const stamps = new Map(projects.map((project) => [project, timestampOf(project)] as const));
  return [...projects].sort(
    (a, b) =>
      stamps.get(b)! - stamps.get(a)! ||
      a.title.localeCompare(b.title) ||
      a.hostId.localeCompare(b.hostId) ||
      a.id.localeCompare(b.id),
  );
}
