/**
 * The Graph Explorer lives beside the chat, not inside a thread, so its clicks reach the active thread through two window
 * events. ThreadView listens (one thread is mounted at a time) and marks the event `handled`; with no listener the overlay
 * falls back to copying. A click never sends an agent turn: asks go to the quick-answer path or into the composer draft.
 */
import type { RepoQuestion } from "@kora/shared/repoReport";

export const GRAPH_ASK_EVENT = "kora:graph-ask";
export const GRAPH_OPEN_FILE_EVENT = "kora:graph-open-file";

export interface GraphAskDetail {
  readonly question: RepoQuestion;
  /** callers / where / impact: try the no-agent quick answer first. */
  readonly route: "quick-answer" | "composer";
  handled: boolean;
  /** Set by the listener when it already knows the question went to the composer (a draft has no graph answer). */
  placed?: "composer";
}

export interface GraphOpenFileDetail {
  readonly file: string;
  readonly line: number | null;
  handled: boolean;
}

function dispatch<T extends { handled: boolean }>(name: string, detail: T): boolean {
  try {
    window.dispatchEvent(new CustomEvent<T>(name, { detail }));
  } catch {
    return false;
  }
  return detail.handled;
}

export function requestGraphAsk(d: Omit<GraphAskDetail, "handled" | "placed">): {
  handled: boolean;
  placed: "composer" | null;
} {
  const detail: GraphAskDetail = { ...d, handled: false };
  const handled = dispatch<GraphAskDetail>(GRAPH_ASK_EVENT, detail);
  return { handled, placed: detail.placed ?? null };
}

export const requestOpenFile = (d: Omit<GraphOpenFileDetail, "handled">): boolean =>
  dispatch<GraphOpenFileDetail>(GRAPH_OPEN_FILE_EVENT, {
    ...d,
    handled: false,
  });
