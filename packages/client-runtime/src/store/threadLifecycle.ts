// @effect-diagnostics globalDate:off -- Optimistic updates are stamped with the dispatch time.
import type { ChatThreadHead, HostId, ThreadId, ThreadIndexSnapshot } from "@kora/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { AtomCommand } from "./runtime.ts";

interface PendingUpdate {
  readonly threadId: ThreadId;
  readonly apply: (thread: ChatThreadHead) => ChatThreadHead;
  /** Set once the server acknowledged the command; the overlay then waits for the stream. */
  sequence?: number;
}

type Snapshot = ThreadIndexSnapshot | null;

export function createOptimisticThreadLifecycle(
  sourceSnapshotAtom: (hostId: HostId) => Atom.Atom<Snapshot>,
) {
  const pendingAtom = Atom.family((hostId: HostId) =>
    Atom.make<ReadonlyArray<PendingUpdate>>([]).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-data:thread-lifecycle:pending:${hostId}`),
    ),
  );

  const snapshotAtom = Atom.family((hostId: HostId) =>
    Atom.make((get): Snapshot => {
      const [source, pending] = [get(sourceSnapshotAtom(hostId)), get(pendingAtom(hostId))];
      if (source === null || pending.length === 0) return source;

      const byThread = new Map<ThreadId, PendingUpdate[]>();
      // Updates the server's stream already reflects are dropped.
      const unseen = pending.filter(
        ({ sequence }) => sequence === undefined || sequence > source.seq,
      );
      for (const update of unseen) {
        const list = byThread.get(update.threadId);
        if (list) list.push(update);
        else byThread.set(update.threadId, [update]);
      }
      if (byThread.size === 0) return source;

      let changed = false;
      const threads = source.threads.map((thread) => {
        const updates = byThread.get(thread.id);
        if (!updates) return thread;
        const next = updates.reduce((current, update) => update.apply(current), thread);
        if (next !== thread) changed = true;
        return next;
      });
      return changed ? { ...source, threads } : source;
    }).pipe(Atom.withLabel(`environment-data:thread-lifecycle:snapshot:${hostId}`)),
  );

  function wrap<
    Input extends { readonly threadId: ThreadId },
    A extends { readonly sequence: number },
    E,
  >(
    command: AtomCommand<{ readonly hostId: HostId; readonly input: Input }, A, E>,
    apply: (thread: ChatThreadHead, input: Input, now: string, accepted: boolean) => ChatThreadHead,
  ): AtomCommand<{ readonly hostId: HostId; readonly input: Input }, A, E> {
    return {
      label: command.label,
      run: async (registry, target) => {
        const now = new Date().toISOString();
        const pending = pendingAtom(target.hostId);
        const update: PendingUpdate = {
          threadId: target.input.threadId,
          apply: (thread) => apply(thread, target.input, now, update.sequence !== undefined),
        };
        const publish = (list: ReadonlyArray<PendingUpdate>) => registry.set(pending, list);
        publish([...registry.get(pending), update]);

        let confirmed = false;
        let stopWatching: (() => void) | null = null;
        const discard = () => {
          stopWatching?.();
          stopWatching = null;
          publish(registry.get(pending).filter((entry) => entry !== update));
        };
        try {
          const result = await command.run(registry, target);
          if (result._tag === "Success") {
            confirmed = true;
            const sequence = result.value.sequence;
            update.sequence = sequence;
            publish([...registry.get(pending)]);
            const reached = (snapshot: Snapshot) => snapshot === null || snapshot.seq >= sequence;
            const source = sourceSnapshotAtom(target.hostId);
            if (reached(registry.get(source))) discard();
            else {
              stopWatching = registry.subscribe(source, (snapshot) => {
                if (reached(snapshot)) discard();
              });
            }
          }
          return result;
        } finally {
          if (!confirmed) discard();
        }
      },
    };
  }

  return { snapshotAtom, wrap };
}
