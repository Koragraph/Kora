// Pure model behind the directory-tree ThreadNav: per-thread status dots, folder
// roll-ups, pinned-first ordering and the filter box. Kept free of React so it is unit-testable.
import { threadMergeRequestSearchTerms } from "@kora/shared/threadMergeRequests";

import { projectSurface } from "../chatSurface";
import type { NavThreadSummary } from "../types";
import {
  hasUnseenCompletion,
  resolveNavThreadStatus,
  searchNavThreads,
  sortPinnedThreadsForSidebar,
} from "./NavRows.logic";
import { isLatestTurnSettled } from "../thread/timeline";

export type ThreadDotTone =
  | "approval"
  | "input"
  | "failed"
  | "offline"
  | "working"
  | "plan"
  | "unread"
  | "monitoring"
  | "idle";

export interface ThreadDot {
  readonly tone: ThreadDotTone;
  /** Human label for the tooltip / screen readers. */
  readonly label: string;
  readonly dotClass: string;
  readonly pulse: boolean;
  /** Failed only: the failure happened after your last visit (opening the chat clears it). */
  readonly unseen?: boolean;
}

// Higher = needs the user sooner. Drives the collapsed-folder roll-up.
const TONE_PRIORITY: Record<ThreadDotTone, number> = {
  offline: 8,
  approval: 7,
  input: 6,
  failed: 5,
  working: 4,
  plan: 3,
  unread: 2,
  monitoring: 1,
  idle: 0,
};

// The palette is four colours, one meaning each (founder spec, 2026-09-27):
//   yellow = needs you · green = finished, not opened yet · grey = finished and seen (pulsing while working)
//   red = something is wrong (turn failed, usage limit, daemon restart killed the turn, daemon offline).
const YELLOW = "bg-amber-500 dark:bg-amber-300/90";
const GREEN = "bg-emerald-500 dark:bg-emerald-300/90";
const RED = "bg-destructive";
const DOTS: Record<ThreadDotTone, Omit<ThreadDot, "tone">> = {
  approval: { label: "Needs your approval", dotClass: YELLOW, pulse: false },
  input: { label: "Waiting for your answer", dotClass: YELLOW, pulse: false },
  plan: { label: "Plan ready for your review", dotClass: YELLOW, pulse: false },
  failed: { label: "Last turn failed", dotClass: RED, pulse: false },
  offline: { label: "Kora daemon is offline", dotClass: RED, pulse: false },
  working: {
    label: "Working",
    dotClass: "bg-muted-foreground animate-status-pulse",
    pulse: true,
  },
  unread: { label: "Finished — not opened yet", dotClass: GREEN, pulse: false },
  monitoring: { label: "Monitoring", dotClass: "bg-muted-foreground", pulse: false },
  idle: { label: "Finished — seen", dotClass: "bg-muted-foreground/60", pulse: false },
};

export type ThreadDotInput = Pick<
  NavThreadSummary,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "session"
  | "latestTurn"
  | "backgroundLiveness"
>;

/**
 * One dot per thread: green = a finished turn the user has not opened yet, grey once seen, yellow when the agent
 * is blocked on the user, red when something went wrong. `hostOffline` = the daemon serving the thread is down.
 */
export function resolveThreadDot(
  thread: ThreadDotInput,
  lastVisitedAt: string | undefined,
  hostOffline = false,
): ThreadDot {
  const tone = hostOffline ? "offline" : resolveThreadDotTone(thread, lastVisitedAt);
  if (tone === "failed")
    return { tone, ...DOTS[tone], unseen: isUnseenFailure(thread, lastVisitedAt) };
  return { tone, ...DOTS[tone] };
}

/** A failed turn you have not opened the chat since. No visit record, or no turn time to compare, counts as unseen. */
function isUnseenFailure(thread: ThreadDotInput, lastVisitedAt: string | undefined): boolean {
  if (!lastVisitedAt) return true;
  const turn = thread.latestTurn;
  const at = turn?.completedAt ?? turn?.startedAt ?? turn?.requestedAt;
  if (!at) return true;
  const failedMs = Date.parse(at);
  const visitedMs = Date.parse(lastVisitedAt);
  if (Number.isNaN(failedMs) || Number.isNaN(visitedMs)) return true;
  return failedMs > visitedMs;
}

function resolveThreadDotTone(
  thread: ThreadDotInput,
  lastVisitedAt: string | undefined,
): ThreadDotTone {
  const status = resolveNavThreadStatus(thread);
  if (status === "approval" || status === "input" || status === "working") return status;
  if (status === "failed") return "failed";
  // An error stays red until the next turn, seen or not: it is a state to act on, not news to read.
  if (thread.latestTurn?.state === "error") return "failed";
  // A turn killed by a daemon restart settles as "interrupted" WITH a reason; a user's Stop carries none.
  if (thread.session?.status === "interrupted" && thread.session.lastError) return "failed";
  const settled = isLatestTurnSettled(thread.latestTurn, thread.session);
  if (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    settled &&
    !thread.hasPendingUserInput
  ) {
    return "plan";
  }
  if (hasUnseenCompletion({ ...thread, lastVisitedAt })) return "unread";
  if (status === "monitoring") return "monitoring";
  return "idle";
}

/**
 * The visit baseline for a thread this client has no record of: "seen as of now-ish". Old threads (and ones
 * from before the dots changed) start grey; a new thread is stamped at creation, so its first reply goes green.
 * Null when a record already exists.
 */
export function baselineVisitFor(
  thread: Pick<ThreadDotInput, "latestTurn"> & { readonly createdAt: string },
  lastVisitedAt: string | undefined,
): string | null {
  if (lastVisitedAt) return null;
  return thread.latestTurn?.completedAt ?? thread.createdAt;
}

/** The most urgent dot among a folder's threads, or null when nothing needs a look. */
export function rollupThreadDots(dots: ReadonlyArray<ThreadDot>): ThreadDot | null {
  let best: ThreadDot | null = null;
  for (const dot of dots) {
    if (TONE_PRIORITY[dot.tone] === 0) continue;
    if (best === null || TONE_PRIORITY[dot.tone] > TONE_PRIORITY[best.tone]) best = dot;
  }
  return best;
}

type OrderableThread = {
  readonly id: string;
  readonly hostId?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string | null | undefined;
  readonly pinOrderKey?: string | null | undefined;
};

/** Pinned threads first (in their pinned order), then newest activity first. */
export function orderFolderThreads<T extends OrderableThread>(threads: readonly T[]): T[] {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const thread of threads) (thread.pinnedAt ? pinned : rest).push(thread);
  rest.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return [...sortPinnedThreadsForSidebar(pinned), ...rest];
}

export interface FilteredFolder<T> {
  /** Threads to show, already ordered. */
  readonly threads: T[];
  /** Whether the folder itself should appear at all. */
  readonly visible: boolean;
}

/**
 * Apply the sidebar filter to one folder. A folder-name match keeps every chat in it; otherwise
 * only chats whose title (or linked PR) matches stay. An empty query is a no-op.
 */
export function filterFolder<
  T extends { readonly title: string } & Parameters<typeof threadMergeRequestSearchTerms>[0],
>(input: { folderTitle: string; threads: readonly T[]; query: string }): FilteredFolder<T> {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return { threads: [...input.threads], visible: true };
  if (input.folderTitle.toLowerCase().includes(query)) {
    return { threads: [...input.threads], visible: true };
  }
  const threads = searchNavThreads(input.threads, query);
  return { threads, visible: threads.length > 0 };
}

/** The OS default double-click interval is ~500 ms on macOS. */
const ROW_DOUBLE_CLICK_MS = 500;

/**
 * Double-click detection that survives a re-render. A thread row's first click navigates, and the
 * row's DOM node can be replaced before the second click lands, so the browser never pairs the two
 * into a `dblclick` (only the already-active row could be renamed that way). This pairs clicks by
 * row key and time instead of by DOM node. `register` returns true on the second click on the same
 * key within the window, then resets so a third click starts over.
 */
export function createRepeatClickDetector(windowMs = ROW_DOUBLE_CLICK_MS) {
  let last: { key: string; at: number } | null = null;
  return {
    register(key: string, now: number): boolean {
      if (last && last.key === key && now - last.at <= windowMs && now >= last.at) {
        last = null;
        return true;
      }
      last = { key, at: now };
      return false;
    },
    reset(): void {
      last = null;
    },
  };
}

/** True when a `truncate` element is cutting its text off (ellipsis showing). */
export function isTextTruncated(
  element:
    | {
        readonly scrollWidth: number;
        readonly clientWidth: number;
        readonly scrollHeight?: number;
        readonly clientHeight?: number;
      }
    | null
    | undefined,
): boolean {
  if (!element) return false;
  // One-line rows clip sideways; the feed's two-line clamp clips downwards.
  return (
    element.scrollWidth > element.clientWidth ||
    (element.scrollHeight ?? 0) > (element.clientHeight ?? 0)
  );
}

/**
 * What an inline rename does when its input loses focus. Only a user leaving the field (pointer
 * down elsewhere, Tab) commits. Anything else is a programmatic focus steal — opening a thread
 * focuses its composer a frame or two after the row's double-click already started the rename —
 * so the input takes focus back. A blur because the whole window went inactive keeps the edit.
 */
export function resolveRenameBlur(input: {
  readonly userLeft: boolean;
  readonly windowFocused: boolean;
}): "commit" | "refocus" | "keep" {
  if (input.userLeft) return "commit";
  return input.windowFocused ? "refocus" : "keep";
}

/**
 * The Code surface's folder list is exactly today's sidebar, restricted to code projects: not a blob's folder
 * (`surface` absent = code, for every project created before the Kora surface existed).
 */
export function filterProjectsForCodeSurface<T extends { readonly surface?: string | undefined }>(
  projects: readonly T[],
): T[] {
  return projects.filter((p) => projectSurface(p) === "code");
}

/** A chat working or waiting on you keeps its project in the sidebar (and never lets it be hidden). */
export const SURFACING_TONES: ReadonlySet<ThreadDotTone> = new Set([
  "approval",
  "input",
  "plan",
  "working",
]);

/** Something to look at: working, waiting on you, finished and not opened, or failed and not opened. */
export function needsALook(dot: Pick<ThreadDot, "tone" | "unseen">): boolean {
  return (
    SURFACING_TONES.has(dot.tone) ||
    dot.tone === "unread" ||
    dot.tone === "offline" ||
    (dot.tone === "failed" && dot.unseen === true)
  );
}

/**
 * Whether a chat shows under its project without the "more" toggle: the open chat, a pinned one, or one that needs a
 * look. Everything else (read, idle, failures you have already opened) folds behind the toggle.
 */
export function isShownThread(
  thread: { readonly id: string; readonly pinnedAt?: string | null | undefined },
  dot: Pick<ThreadDot, "tone" | "unseen">,
  activeId: string | undefined,
): boolean {
  return thread.id === activeId || !!thread.pinnedAt || needsALook(dot);
}

export type LastOpenedByProject = Readonly<Record<string, { threadId: string; at: string }>>;

/** Records the chat just opened as its project's; keeps the `max` most recent projects. */
export function rememberOpened(
  prev: LastOpenedByProject,
  projectKey: string,
  threadId: string,
  at: string,
  max = 6,
): LastOpenedByProject {
  if (prev[projectKey]?.threadId === threadId) return prev;
  const entries = Object.entries({ ...prev, [projectKey]: { threadId, at } })
    .sort(([, a], [, b]) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, max);
  return Object.fromEntries(entries);
}

export type SidebarShortcut = "new-thread" | "search";

/**
 * ⌘N / ⌘K (Ctrl+N / Ctrl+K off the Mac) for the sidebar's New thread and Search rows. Only the bare chord: no Shift or
 * Alt, and the other platform's modifier must be up (Ctrl+K on a Mac is the terminal's, not ours).
 */
export function resolveSidebarShortcut(
  event: {
    readonly key: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
    readonly isComposing?: boolean;
  },
  mac: boolean,
): SidebarShortcut | null {
  if (event.isComposing || event.altKey || event.shiftKey) return null;
  const chord = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!chord) return null;
  const key = event.key.toLowerCase();
  if (key === "n") return "new-thread";
  if (key === "k") return "search";
  return null;
}

export type ThreadCardLookKind = "working" | "needs" | "unread" | "failed" | "quiet";

export interface ThreadCardLook {
  readonly kind: ThreadCardLookKind;
  /** Nothing to look at: dimmer title, no sprite. */
  readonly quiet: boolean;
  /** Said after the model: what it needs, that it finished, or that it failed. */
  readonly word: string | null;
  readonly wordClass: string;
  /** The resting sprite under the time (the working one is LeadBlob's animation). */
  readonly sprite: "wait" | "done" | "fail" | null;
}

/**
 * How a sidebar card shows its chat's state. Amber = needs you, green = finished and not opened, red = failed (with
 * the upset sprite until you open it), working = the running outline and Kora's animation.
 */
export function resolveThreadCardLook(dot: Pick<ThreadDot, "tone" | "unseen">): ThreadCardLook {
  switch (dot.tone) {
    case "working":
      return { kind: "working", quiet: false, word: null, wordClass: "", sprite: null };
    case "approval":
      return {
        kind: "needs",
        quiet: false,
        word: "Needs approval",
        wordClass: AMBER_TEXT,
        sprite: "wait",
      };
    case "input":
      return {
        kind: "needs",
        quiet: false,
        word: "Has a question",
        wordClass: AMBER_TEXT,
        sprite: "wait",
      };
    case "plan":
      return {
        kind: "needs",
        quiet: false,
        word: "Plan ready",
        wordClass: AMBER_TEXT,
        sprite: "wait",
      };
    case "unread":
      return {
        kind: "unread",
        quiet: false,
        word: "Finished",
        wordClass: GREEN_TEXT,
        sprite: "done",
      };
    case "offline":
      return { kind: "failed", quiet: false, word: "Offline", wordClass: RED_TEXT, sprite: "fail" };
    case "failed":
      return dot.unseen
        ? { kind: "failed", quiet: false, word: "Failed", wordClass: RED_TEXT, sprite: "fail" }
        : { kind: "quiet", quiet: true, word: "Failed", wordClass: RED_TEXT, sprite: null };
    default:
      return { kind: "quiet", quiet: true, word: null, wordClass: "", sprite: null };
  }
}
const AMBER_TEXT = "text-amber-500 dark:text-amber-300";
const GREEN_TEXT = "text-emerald-600 dark:text-emerald-400";
const RED_TEXT = "text-destructive";

/** The card's checkout line: the branch, else the worktree folder's name, else the project's own checkout. */
export function threadCheckoutLabel(thread: {
  readonly branch: string | null;
  readonly worktreePath: string | null;
}): string {
  if (thread.branch) return thread.branch;
  if (thread.worktreePath)
    return thread.worktreePath.split(/[\\/]/).findLast(Boolean) ?? "Worktree";
  return "Current checkout";
}
