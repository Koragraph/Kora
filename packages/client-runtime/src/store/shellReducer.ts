import type { ThreadIndexEvent, ThreadIndexSnapshot } from "@kora/contracts";

/** Replace the item with the same id in place, or add it at the end. */
function upsertById<T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  item: T,
): ReadonlyArray<T> {
  const at = items.findIndex(({ id }) => id === item.id);
  if (at === -1) return [...items, item];
  const next = items.slice();
  next[at] = item;
  return next;
}

const withoutId = <T extends { readonly id: string }>(items: ReadonlyArray<T>, id: string) =>
  items.filter((item) => item.id !== id);

/**
 * Fold one thread-index stream event into a snapshot. Pure, shared by web and mobile.
 *
 * Events at or below the snapshot's sequence and event kinds this build does not know leave
 * the snapshot as the very same object (forward-compatible).
 */
export function applySummaryStreamEvent(
  snapshot: ThreadIndexSnapshot,
  event: ThreadIndexEvent,
): ThreadIndexSnapshot {
  if (event.sequence <= snapshot.seq) return snapshot;
  const advanced = (change: Partial<ThreadIndexSnapshot>): ThreadIndexSnapshot => ({
    ...snapshot,
    ...change,
    seq: event.sequence,
  });

  if (event.kind === "project-upserted")
    return advanced({ projects: upsertById(snapshot.projects, event.project) });
  if (event.kind === "project-removed")
    return advanced({ projects: withoutId(snapshot.projects, event.projectId) });
  if (event.kind === "thread-upserted")
    return advanced({ threads: upsertById(snapshot.threads, event.thread) });
  if (event.kind === "thread-removed")
    return advanced({ threads: withoutId(snapshot.threads, event.threadId) });
  return snapshot;
}
