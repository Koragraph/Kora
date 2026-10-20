import { useCallback, useEffect, useMemo, useRef } from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Schema from "effect/Schema";
import { useRouter } from "@tanstack/react-router";
import type { HostId, HostThreadRef, ThreadId } from "@kora/contracts";
import { canSnooze, threadWokeAt } from "@kora/client-runtime/store/thread-settled";
import { settlePromise, type AtomActionResult } from "@kora/client-runtime/store/runtime";
import { hostThreadKey, hostProjectRef, hostThreadRef } from "@kora/client-runtime/host";

import { useStartNewThread } from "./useStartThread";
import { getClientPrefs, useClientPrefs } from "./usePrefs";
import { refreshArchivedThreadsForHost } from "../util/archivedThreadsState";
import { resolveThreadPageRef } from "../thread/threadRoutes";
import { useViewStateStore } from "../stores/uiStateStore";
import { usePromptDraftStore } from "../stores/promptDraftStore";
import { readLocalApi } from "../localApi";
import { toastManager } from "../components/ui/toast";
import { getFallbackThreadIdAfterDelete, pinOrderKeyBetween } from "../components/NavRows.logic";
import { useAtomAction } from "../atoms/use-atom-command";
import { threadHost } from "../atoms/threads";
import { terminalHost } from "../atoms/terminal";
import {
  readThreadSummaries,
  readThreadSummary,
  readHostSupportsSnooze,
  readHostSupportsSettlement,
  readHostSupportsPinning,
  readHostSupportsPinReorder,
  readHostSupportsActiveReorder,
} from "../atoms/entities";

const refusal = {
  hostId: Schema.String as unknown as Schema.Codec<HostId, HostId>,
  threadId: Schema.String as unknown as Schema.Codec<ThreadId, ThreadId>,
};

export class ThreadArchiveRefusedError extends Schema.TaggedError<ThreadArchiveRefusedError>()(
  "ThreadArchiveRefusedError",
  refusal,
) {
  override get message() {
    return "Stop the turn before archiving this chat.";
  }
}

export class ThreadSettlementUnsupportedError extends Schema.TaggedError<ThreadSettlementUnsupportedError>()(
  "ThreadSettlementUnsupportedError",
  refusal,
) {
  override get message() {
    return "Kora's service is too old to mark chats done. Restart Kora to update it.";
  }
}

export class ThreadSnoozeUnsupportedError extends Schema.TaggedError<ThreadSnoozeUnsupportedError>()(
  "ThreadSnoozeUnsupportedError",
  refusal,
) {
  override get message() {
    const detail =
      "This environment's server does not support snoozing yet. Update the server to use Snooze.";
    return detail;
  }
}

export class ThreadSnoozeBlockedError extends Schema.TaggedError<ThreadSnoozeBlockedError>()(
  "ThreadSnoozeBlockedError",
  refusal,
) {
  override get message() {
    return "This chat is waiting on you. Answer the open request before snoozing it.";
  }
}

export class ThreadPinningUnsupportedError extends Schema.TaggedError<ThreadPinningUnsupportedError>()(
  "ThreadPinningUnsupportedError",
  refusal,
) {
  override get message() {
    const detail =
      "This environment's server does not support pinning yet. Update the server to use Pin.";
    return detail;
  }
}

export class ThreadPinReorderUnsupportedError extends Schema.TaggedError<ThreadPinReorderUnsupportedError>()(
  "ThreadPinReorderUnsupportedError",
  refusal,
) {
  override get message() {
    const detail = "This version of Kora can't reorder pinned chats. Update Kora to reorder pins.";
    return detail;
  }
}

export class ThreadActiveReorderUnsupportedError extends Schema.TaggedError<ThreadActiveReorderUnsupportedError>()(
  "ThreadActiveReorderUnsupportedError",
  refusal,
) {
  override get message() {
    return "Update Kora to reorder active chats.";
  }
}

type Outcome<Ok = unknown> = Promise<AtomActionResult<Ok, unknown>>;

const unpinMessage = (heading: string) =>
  `Unpin chat "${heading}"?\nIt moves out of your pinned section.`;

export function requestThreadUnpinConfirmation(args: {
  enabled: boolean;
  title: string;
  confirm: ((msg: string) => Promise<boolean>) | null;
}): Promise<AtomActionResult<boolean, unknown>> {
  if (!args.enabled || !args.confirm) return Promise.resolve(AsyncResult.success(true));
  const confirm = args.confirm;
  return settlePromise(() => confirm(unpinMessage(args.title)));
}

export async function navigateAfterThreadDeletion(navigate: () => Promise<void>): Promise<void> {
  try {
    await navigate();
  } catch (err) {
    // The thread is gone either way, so this never changes the delete result.
    toastManager.add({
      type: "error",
      title: "Chat deleted, but navigation failed",
      description: err instanceof Error ? err.message : "An error occurred.",
    });
  }
}

const failed = <Err>(err: Err) => AsyncResult.fail(err);
const done = () => AsyncResult.success(undefined);

function newestPinKey(): string | null {
  let smallest: string | null = null;
  for (const sh of readThreadSummaries()) {
    const keyName = sh.pinnedAt ? sh.pinOrderKey : null;
    if (keyName && (smallest === null || keyName < smallest)) smallest = keyName;
  }
  return smallest;
}

export function useThreadCommands() {
  const router = useRouter();
  const openNewThread = useStartNewThread();
  const openNewThreadRef = useRef(openNewThread);
  useEffect(() => {
    openNewThreadRef.current = openNewThread;
  }, [openNewThread]);

  const confirmDelete = useClientPrefs((prefs) => prefs.confirmThreadDelete);
  const confirmUnpin = useClientPrefs((prefs) => prefs.confirmThreadUnpin);

  const archiveCommand = useAtomAction(threadHost.archive, { reportFailure: false });
  const unarchiveCommand = useAtomAction(threadHost.unarchive, { reportFailure: false });
  const deleteCommand = useAtomAction(threadHost.delete, { reportFailure: false });
  const settleCommand = useAtomAction(threadHost.settle, { reportFailure: false });
  const unsettleCommand = useAtomAction(threadHost.unsettle, { reportFailure: false });
  const snoozeCommand = useAtomAction(threadHost.snooze, { reportFailure: false });
  const unsnoozeCommand = useAtomAction(threadHost.unsnooze, { reportFailure: false });
  const pinCommand = useAtomAction(threadHost.pin, { reportFailure: false });
  const unpinCommand = useAtomAction(threadHost.unpin, { reportFailure: false });
  const reorderPinCommand = useAtomAction(threadHost.reorderPin, { reportFailure: false });
  const reorderActiveCommand = useAtomAction(threadHost.reorderActive, { reportFailure: false });
  const stopSessionCommand = useAtomAction(threadHost.stopSession, { reportFailure: false });
  const closeTerminalCommand = useAtomAction(terminalHost.close, { reportFailure: false });

  const isOnScreen = useCallback(
    (dest: HostThreadRef) => {
      const routeParams = (router.state.matches.at(-1)?.params ?? {}) as Record<
        string,
        string | undefined
      >;
      const shown = resolveThreadPageRef(routeParams);
      return shown?.hostId === dest.hostId && shown.threadId === dest.threadId;
    },
    [router],
  );

  const markVisitedAtWake = useCallback((dest: HostThreadRef) => {
    const sh = readThreadSummary(dest);
    if (!sh) return;
    const clock = new Date().toISOString();
    const wokeAt = threadWokeAt(sh, { now: clock });
    if (wokeAt) useViewStateStore.getState().markThreadVisited(hostThreadKey(dest), wokeAt);
  }, []);

  const archiveThread = useCallback(
    async (dest: HostThreadRef, opts?: { onArchived?: () => void }): Outcome => {
      const sh = readThreadSummary(dest);
      if (!sh) return done();
      if (sh.session?.status === "running" && sh.session.activeTurnId) {
        return failed(
          new ThreadArchiveRefusedError({ hostId: dest.hostId, threadId: dest.threadId }),
        );
      }
      const wasOnScreen = isOnScreen(dest);
      const result = await archiveCommand({
        hostId: dest.hostId,
        input: { threadId: dest.threadId },
      });
      if (result._tag === "Failure") return result;

      if (wasOnScreen) {
        try {
          await openNewThreadRef.current(hostProjectRef(sh.hostId, sh.projectId), {
            replace: true,
          });
        } catch (err) {
          return failed(err);
        }
      }
      markVisitedAtWake(dest);
      refreshArchivedThreadsForHost(dest.hostId);
      opts?.onArchived?.();
      return result;
    },
    [archiveCommand, isOnScreen, markVisitedAtWake],
  );

  const unarchiveThread = useCallback(
    async (dest: HostThreadRef): Outcome => {
      const result = await unarchiveCommand({
        hostId: dest.hostId,
        input: { threadId: dest.threadId },
      });
      if (result._tag === "Success") refreshArchivedThreadsForHost(dest.hostId);
      return result;
    },
    [unarchiveCommand],
  );

  const deleteThread = useCallback(
    async (dest: HostThreadRef, opts?: { deletedThreadKeys?: ReadonlySet<string> }): Outcome => {
      const request = { hostId: dest.hostId, input: { threadId: dest.threadId } };
      const sh = readThreadSummary(dest);

      // An archived thread is not in the main store: nothing to stop, close or navigate away from.
      if (!sh) {
        const result = await deleteCommand(request);
        if (result._tag === "Success") refreshArchivedThreadsForHost(dest.hostId);
        return result;
      }

      const wasOnScreen = isOnScreen(dest);
      if (sh.session && sh.session.status !== "stopped") {
        await stopSessionCommand(request);
      }
      await closeTerminalCommand({
        hostId: dest.hostId,
        input: { threadId: dest.threadId, deleteHistory: true },
      });

      const siblings = readThreadSummaries().filter((tt) => tt.hostId === dest.hostId);
      const alsoDeleted = new Set(
        siblings
          .filter((tt) =>
            opts?.deletedThreadKeys?.has(hostThreadKey(hostThreadRef(tt.hostId, tt.id))),
          )
          .map((tt) => tt.id),
      );
      const fallbackId = getFallbackThreadIdAfterDelete({
        threads: siblings,
        deletedThreadId: dest.threadId,
        sortOrder: getClientPrefs().sidebarThreadSortOrder,
        deletedThreadIds: alsoDeleted,
      });

      const result = await deleteCommand(request);
      if (result._tag === "Failure") return result;

      refreshArchivedThreadsForHost(dest.hostId);
      const drafts = usePromptDraftStore.getState();
      drafts.clearDraftThread(dest);
      drafts.clearProjectDraftThreadById(hostProjectRef(sh.hostId, sh.projectId), dest);
      drafts.clearComposerContent(dest);

      if (wasOnScreen) {
        await navigateAfterThreadDeletion(() =>
          fallbackId
            ? router.navigate({
                to: "/$hostId/$threadId",
                params: { hostId: dest.hostId, threadId: fallbackId },
                replace: true,
              })
            : router.navigate({ to: "/", replace: true }),
        );
      }
      return result;
    },
    [closeTerminalCommand, deleteCommand, isOnScreen, router, stopSessionCommand],
  );

  const confirmAndDeleteThread = useCallback(
    async (dest: HostThreadRef): Outcome => {
      const apiClient = readLocalApi();
      if (confirmDelete && apiClient) {
        const heading = readThreadSummary(dest)?.title ?? "this chat";
        const asked = await settlePromise(() =>
          apiClient.dialogs.confirm(
            `Delete chat "${heading}"?\nThis permanently deletes the chat from Kora. It can't be undone.`,
            { variant: "destructive", confirmLabel: "Delete" },
          ),
        );
        if (asked._tag === "Failure") return asked;
        if (!asked.value) return done();
      }
      return deleteThread(dest);
    },
    [confirmDelete, deleteThread],
  );

  const settleThread = useCallback(
    async (dest: HostThreadRef): Outcome => {
      if (!readHostSupportsSettlement(dest.hostId)) {
        return failed(
          new ThreadSettlementUnsupportedError({
            hostId: dest.hostId,
            threadId: dest.threadId,
          }),
        );
      }
      const result = await settleCommand({
        hostId: dest.hostId,
        input: { threadId: dest.threadId },
      });
      if (result._tag === "Success") markVisitedAtWake(dest);
      return result;
    },
    [markVisitedAtWake, settleCommand],
  );

  const unsettleThread = useCallback(
    async (dest: HostThreadRef): Outcome => {
      if (!readHostSupportsSettlement(dest.hostId)) {
        return failed(
          new ThreadSettlementUnsupportedError({
            hostId: dest.hostId,
            threadId: dest.threadId,
          }),
        );
      }
      // reason "user" pins the thread active so auto-settle stays out of the way.
      return unsettleCommand({
        hostId: dest.hostId,
        input: { threadId: dest.threadId, reason: "user" },
      });
    },
    [unsettleCommand],
  );

  const snoozeThread = useCallback(
    async (dest: HostThreadRef, snoozedUntil: string): Outcome => {
      if (!readHostSupportsSnooze(dest.hostId)) {
        return failed(
          new ThreadSnoozeUnsupportedError({ hostId: dest.hostId, threadId: dest.threadId }),
        );
      }
      const sh = readThreadSummary(dest);
      if (sh && !canSnooze(sh, { now: new Date().toISOString() })) {
        return failed(
          new ThreadSnoozeBlockedError({ hostId: dest.hostId, threadId: dest.threadId }),
        );
      }
      return snoozeCommand({
        hostId: dest.hostId,
        input: { threadId: dest.threadId, snoozedUntil },
      });
    },
    [snoozeCommand],
  );

  const unsnoozeThread = useCallback(
    async (dest: HostThreadRef): Outcome => {
      if (!readHostSupportsSnooze(dest.hostId)) {
        return failed(
          new ThreadSnoozeUnsupportedError({ hostId: dest.hostId, threadId: dest.threadId }),
        );
      }
      return unsnoozeCommand({
        hostId: dest.hostId,
        input: { threadId: dest.threadId, reason: "user" },
      });
    },
    [unsnoozeCommand],
  );

  const pinThread = useCallback(
    async (dest: HostThreadRef, opts?: { orderKey?: string }): Outcome => {
      if (!readHostSupportsPinning(dest.hostId)) {
        return failed(
          new ThreadPinningUnsupportedError({ hostId: dest.hostId, threadId: dest.threadId }),
        );
      }
      let orderKey: string | undefined;
      // Hosts without pin reordering get the bare pin.
      if (readHostSupportsPinReorder(dest.hostId)) {
        orderKey = opts?.orderKey;
        if (orderKey === undefined) {
          try {
            orderKey = pinOrderKeyBetween(null, newestPinKey()) ?? undefined;
          } catch {
            orderKey = undefined; // placement must never make pinning fail
          }
        }
      }
      return pinCommand({
        hostId: dest.hostId,
        input: { threadId: dest.threadId, ...(orderKey !== undefined ? { orderKey } : {}) },
      });
    },
    [pinCommand],
  );

  const unpinThread = useCallback(
    async (dest: HostThreadRef): Outcome => {
      if (!readHostSupportsPinning(dest.hostId)) {
        return failed(
          new ThreadPinningUnsupportedError({ hostId: dest.hostId, threadId: dest.threadId }),
        );
      }
      return unpinCommand({ hostId: dest.hostId, input: { threadId: dest.threadId } });
    },
    [unpinCommand],
  );

  const confirmAndUnpinThread = useCallback(
    async (dest: HostThreadRef): Outcome => {
      const apiClient = readLocalApi();
      const asked = await requestThreadUnpinConfirmation({
        enabled: confirmUnpin,
        title: readThreadSummary(dest)?.title ?? "this chat",
        confirm: apiClient ? (msg) => apiClient.dialogs.confirm(msg) : null,
      });
      if (asked._tag === "Failure") return asked;
      if (!asked.value) return done();
      return unpinThread(dest);
    },
    [confirmUnpin, unpinThread],
  );

  const reorderPinnedThread = useCallback(
    async (dest: HostThreadRef, orderKey: string): Outcome => {
      if (!readHostSupportsPinReorder(dest.hostId)) {
        return failed(
          new ThreadPinReorderUnsupportedError({
            hostId: dest.hostId,
            threadId: dest.threadId,
          }),
        );
      }
      return reorderPinCommand({
        hostId: dest.hostId,
        input: { threadId: dest.threadId, orderKey },
      });
    },
    [reorderPinCommand],
  );

  const reorderActiveThread = useCallback(
    async (dest: HostThreadRef, orderKey: string): Outcome => {
      if (!readHostSupportsActiveReorder(dest.hostId)) {
        return failed(
          new ThreadActiveReorderUnsupportedError({
            hostId: dest.hostId,
            threadId: dest.threadId,
          }),
        );
      }
      return reorderActiveCommand({
        hostId: dest.hostId,
        input: { threadId: dest.threadId, orderKey },
      });
    },
    [reorderActiveCommand],
  );

  return useMemo(
    () => ({
      reorderActiveThread,
      reorderPinnedThread,
      confirmAndUnpinThread,
      unpinThread,
      pinThread,
      unsnoozeThread,
      snoozeThread,
      unsettleThread,
      settleThread,
      confirmAndDeleteThread,
      deleteThread,
      unarchiveThread,
      archiveThread,
    }),
    [
      reorderActiveThread,
      reorderPinnedThread,
      confirmAndUnpinThread,
      unpinThread,
      pinThread,
      unsnoozeThread,
      snoozeThread,
      unsettleThread,
      settleThread,
      confirmAndDeleteThread,
      deleteThread,
      unarchiveThread,
      archiveThread,
    ],
  );
}
