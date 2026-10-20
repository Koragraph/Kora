import { useMemo } from "react";
import { ThreadId, type HostId, type PtyAttachInput, type PtySummary } from "@kora/contracts";
import {
  type PtySessionState,
  type KnownTerminalSession,
  EMPTY_TERMINAL_SESSION_STATE,
  EMPTY_TERMINAL_BUFFER_STATE,
  combinePtySessionState,
} from "@kora/client-runtime/store/terminal";

import { terminalHost } from "./terminal";
import { useHostQuery } from "./query";

const NO_SESSIONS: ReadonlyArray<KnownTerminalSession> = Object.freeze([]);
const collator = new Intl.Collator(undefined, { numeric: true });

/** One metadata snapshot, sorted once and bucketed by thread; views are cached per snapshot. */
interface SnapshotIndex {
  readonly everything: ReadonlyArray<PtySummary>;
  readonly perThread: ReadonlyMap<string, ReadonlyArray<PtySummary>>;
  readonly views: Map<string, ReadonlyArray<KnownTerminalSession>>;
}

const indexBySnapshot = new WeakMap<ReadonlyArray<PtySummary>, SnapshotIndex>();

function indexOf(metadata: ReadonlyArray<PtySummary>): SnapshotIndex {
  const cached = indexBySnapshot.get(metadata);
  if (cached) return cached;
  // Spread reads each element once; sort is stable so equal numeric ids keep arrival order.
  const everything = [...metadata].sort((left, right) =>
    collator.compare(left.terminalId, right.terminalId),
  );
  const perThread = new Map<string, PtySummary[]>();
  for (const summary of everything) {
    const bucket = perThread.get(summary.threadId);
    if (bucket) bucket.push(summary);
    else perThread.set(summary.threadId, [summary]);
  }
  const pos: SnapshotIndex = { everything, perThread, views: new Map() };
  indexBySnapshot.set(metadata, pos);
  return pos;
}

// A session object is a pure function of (summary object, host).
const sessionCache = new WeakMap<PtySummary, Map<HostId, KnownTerminalSession>>();

function sessionFor(summary: PtySummary, hostKey: HostId): KnownTerminalSession {
  let perHost = sessionCache.get(summary);
  if (!perHost) sessionCache.set(summary, (perHost = new Map()));
  let sess = perHost.get(hostKey);
  if (!sess) {
    sess = {
      target: {
        hostId: hostKey,
        threadId: ThreadId.make(summary.threadId),
        terminalId: summary.terminalId,
      },
      state: combinePtySessionState(summary, EMPTY_TERMINAL_BUFFER_STATE),
    };
    perHost.set(hostKey, sess);
  }
  return sess;
}

// Lets a fresh snapshot with identical summaries hand back the previous group array.
// Anchored on the group's first summary and held weakly so old groups can be collected.
const previousGroups = new WeakMap<
  PtySummary,
  Map<string, WeakRef<ReadonlyArray<KnownTerminalSession>>>
>();

function buildGroup(
  summaries: ReadonlyArray<PtySummary>,
  hostKey: HostId,
  variant: "all" | "thread",
): ReadonlyArray<KnownTerminalSession> {
  const anch = summaries[0]!;
  let slots = previousGroups.get(anch);
  if (!slots) previousGroups.set(anch, (slots = new Map()));
  const slotKey = `${hostKey}|${variant}`;

  const earlier = slots.get(slotKey)?.deref();
  if (
    earlier &&
    earlier.length === summaries.length &&
    earlier.every((sess, idx) => sess.state.summary === summaries[idx])
  ) {
    return earlier;
  }
  const group = summaries.map((summary) => sessionFor(summary, hostKey));
  slots.set(slotKey, new WeakRef(group));
  return group;
}

export function selectKnownTerminalSessions(
  metadata: ReadonlyArray<PtySummary> | null,
  hostKey: HostId | null,
  threadKey: ThreadId | null,
): ReadonlyArray<KnownTerminalSession> {
  if (hostKey === null || metadata === null || metadata.length === 0) return NO_SESSIONS;
  const pos = indexOf(metadata);
  const viewKey = `${hostKey}|${threadKey ?? "*"}`;
  const cached = pos.views.get(viewKey);
  if (cached) return cached;

  const summaries = threadKey === null ? pos.everything : pos.perThread.get(threadKey);
  const surfaceView =
    summaries && summaries.length > 0
      ? buildGroup(summaries, hostKey, threadKey === null ? "all" : "thread")
      : NO_SESSIONS;
  pos.views.set(viewKey, surfaceView);
  return surfaceView;
}

export function useAttachedTerminalSession(args: {
  readonly hostId: HostId | null;
  readonly terminal: PtyAttachInput | null;
}): PtySessionState {
  const { hostId, terminal } = args;
  const attach = useHostQuery(
    hostId !== null && terminal !== null ? terminalHost.attach({ hostId, input: terminal }) : null,
  );
  const metadata = useHostQuery(
    hostId !== null ? terminalHost.metadata({ hostId, input: null }) : null,
  );

  return useMemo(() => {
    if (hostId === null || terminal === null) return EMPTY_TERMINAL_SESSION_STATE;
    const summary =
      metadata.data === null
        ? null
        : (indexOf(metadata.data)
            .perThread.get(terminal.threadId)
            ?.find((item) => item.terminalId === terminal.terminalId) ?? null);
    const combined = combinePtySessionState(summary, attach.data ?? EMPTY_TERMINAL_BUFFER_STATE);
    return attach.error === null ? combined : { ...combined, error: attach.error, status: "error" };
  }, [attach.data, attach.error, hostId, metadata.data, terminal]);
}

export function useKnownTerminalSessions(args: {
  readonly hostId: HostId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<KnownTerminalSession> {
  const { hostId, threadId } = args;
  const metadata = useHostQuery(
    hostId !== null ? terminalHost.metadata({ hostId, input: null }) : null,
  );
  return useMemo(
    () => selectKnownTerminalSessions(metadata.data, hostId, threadId),
    [hostId, metadata.data, threadId],
  );
}
