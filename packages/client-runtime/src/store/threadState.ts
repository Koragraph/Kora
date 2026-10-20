import type { ChatThread } from "@kora/contracts";
import * as Option from "effect/Option";

export type HostThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

/**
 * Pagination state for a windowed thread. Present only when the loaded thread
 * is a window (the server returned `page` metadata); absent means the thread is
 * fully loaded — either the server predates pagination or the window reached
 * the top.
 */
export interface HostThreadPageState {
  /** True while an older page fetch is in flight. */
  readonly loadingOlder: boolean;
  /** Opaque exclusive cursor for the next older slice; null when fully loaded. */
  readonly beforeCursor: string | null;
  readonly hasMore: boolean;
}

export interface HostThreadState {
  readonly data: Option.Option<ChatThread>;
  readonly status: HostThreadStatus;
  readonly error: Option.Option<string>;
  readonly page: Option.Option<HostThreadPageState>;
}

export const EMPTY_HOST_THREAD_STATE: HostThreadState = {
  page: Option.none(),
  error: Option.none(),
  status: "empty",
  data: Option.none(),
};

/** Whether the thread has older turns that can be loaded with more pages. */
export function threadHasOlderTurns(state: HostThreadState): boolean {
  return Option.exists(state.page, ({ hasMore }) => hasMore);
}
