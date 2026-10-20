// "Needs you": the threads blocked on the user (a pending approval or a question), newest activity first.
// Plan-ready and failed threads keep their dots in the list but are not blocked, so they are not counted here.
import { resolveNavThreadStatus } from "../NavRows.logic";

export interface NeedsYouThread {
  readonly hostId: string;
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly archivedAt?: string | null | undefined;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly session?: { readonly status?: string | undefined } | null | undefined;
}

export interface NeedsYouEntry<T extends NeedsYouThread> {
  readonly thread: T;
  readonly reason: "approval" | "input";
}

/** `inScope` limits it to a surface's projects (Code); archived threads never count. */
export function collectNeedsYou<T extends NeedsYouThread>(
  threads: ReadonlyArray<T>,
  inScope: (thread: T) => boolean = () => true,
): NeedsYouEntry<T>[] {
  const out: NeedsYouEntry<T>[] = [];
  for (const thread of threads) {
    if (thread.archivedAt || !inScope(thread)) continue;
    const status = resolveNavThreadStatus(thread as Parameters<typeof resolveNavThreadStatus>[0]);
    if (status === "approval" || status === "input") out.push({ thread, reason: status });
  }
  out.sort((a, b) =>
    a.thread.updatedAt < b.thread.updatedAt ? 1 : a.thread.updatedAt > b.thread.updatedAt ? -1 : 0,
  );
  return out;
}

export const needsYouLabel = (count: number): string =>
  count === 1 ? "1 chat needs you" : `${count} chats need you`;
