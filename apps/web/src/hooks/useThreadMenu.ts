import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { HostThreadRef } from "@kora/contracts";
import { canSnooze, effectiveSnoozed } from "@kora/client-runtime/store/thread-settled";
import {
  isAtomActionInterrupted,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import { hostThreadKey, hostProjectRef } from "@kora/client-runtime/host";

import { useThreadCommands } from "./useThreadCommands";
import { useStartNewThread } from "./useStartThread";
import { getClientPrefs, useClientPrefs } from "./usePrefs";
import { writeTextToClipboard } from "./useCopyText";
import { useViewStateStore } from "../stores/uiStateStore";
import { readLocalApi } from "../localApi";
import { threadToast, toastManager } from "../components/ui/toast";
import {
  buildThreadActionMenuItems,
  type ThreadActionMenuId,
} from "../components/threadMenu.logic";
import { resolveSnoozePresets, snoozeWakeDescription } from "../components/NavRows.snooze";
import { requestCustomSnooze } from "../components/SnoozeUntilDialog";
import { projectSurface } from "../chatSurface";
import { useAtomAction } from "../atoms/use-atom-command";
import { threadHost } from "../atoms/threads";
import {
  readThreadSummary,
  readProjects,
  readHostSupportsTitleRegeneration,
  readHostSupportsSnooze,
  readHostSupportsSettlement,
  readHostSupportsPinning,
} from "../atoms/entities";

type Outcome = { _tag: "Success" } | { _tag: "Failure"; cause: unknown };

const messageOf = (err: unknown) =>
  err instanceof Error && err.message ? err.message : "An error occurred.";

function errorToast(heading: string, err: unknown) {
  toastManager.add(threadToast({ type: "error", title: heading, description: messageOf(err) }));
}

export function useThreadMenu(options: {
  readonly onStartRename: () => void;
  readonly projectCwd: string | null;
  readonly threadRef: HostThreadRef | null;
}): { openMenu: (place: { x: number; y: number }) => void; closeMenu: () => void } {
  const { threadRef, projectCwd, onStartRename } = options;
  const navigate = useNavigate();
  const openNewThread = useStartNewThread();
  const actions = useThreadCommands();
  const updateMetadata = useAtomAction(threadHost.updateMetadata, { reportFailure: false });
  const confirmArchive = useClientPrefs((prefs) => prefs.confirmThreadArchive);
  const confirmDelete = useClientPrefs((prefs) => prefs.confirmThreadDelete);

  /** Toasts a failed action unless the user (or navigation) interrupted it. */
  const reportFailure = useCallback((result: Outcome, heading: string) => {
    if (result._tag === "Success") return;
    if (isAtomActionInterrupted(result as never)) return;
    errorToast(heading, squashAtomActionFailure(result as never));
  }, []);

  const copy = useCallback(
    (val: string, dest: string, okTitle: string, okDescription: string, failTitle: string) => {
      writeTextToClipboard(val, dest).then(
        () => toastManager.add({ type: "success", title: okTitle, description: okDescription }),
        (err: unknown) => errorToast(failTitle, err),
      );
    },
    [],
  );

  const snooze = useCallback(
    async (handle: HostThreadRef, choice: string) => {
      const timestampFormat = getClientPrefs().timestampFormat;
      let until: string | null = null;
      if (choice === "snooze:custom") {
        until = (await requestCustomSnooze())?.snoozedUntil ?? null;
      } else {
        const presetId = choice.slice("snooze:".length);
        until =
          resolveSnoozePresets(new Date(), timestampFormat).find((preset) => preset.id === presetId)
            ?.snoozedUntil ?? null;
      }
      if (until === null) return;

      const result = await actions.snoozeThread(handle, until);
      if (result._tag === "Failure") {
        reportFailure(result, "Failed to snooze chat");
        return;
      }
      const wakeText = snoozeWakeDescription(until, new Date(), timestampFormat);
      toastManager.add(
        threadToast({
          title: `Snoozed until ${wakeText}`,
          type: "success",
          timeout: 5000,
          actionProps: {
            children: "Undo",
            onClick: () => {
              void actions
                .unsnoozeThread(handle)
                .then((undone) => reportFailure(undone, "Could not bring the chat back"));
            },
          },
        }),
      );
    },
    [actions, reportFailure],
  );

  const archive = useCallback(
    async (handle: HostThreadRef, heading: string) => {
      const apiClient = readLocalApi();
      if (confirmArchive && apiClient) {
        const ok = await apiClient.dialogs.confirm(`Archive chat "${heading}"?`, {
          confirmLabel: "Archive",
        });
        if (!ok) return;
      }
      const result = await actions.archiveThread(handle);
      if (result._tag === "Success") {
        toastManager.add(
          threadToast({
            title: "Archived",
            type: "success",
            timeout: 5000,
            actionProps: {
              children: "Undo",
              onClick: () => {
                void actions
                  .unarchiveThread(handle)
                  .then((undone) => reportFailure(undone, "Could not unarchive the chat"));
              },
            },
          }),
        );
        return;
      }
      if (isAtomActionInterrupted(result)) return;
      const reason = squashAtomActionFailure(result);
      const archived = readThreadSummary(handle)?.archivedAt != null;
      errorToast(
        archived ? "Chat archived, but navigation failed" : "Failed to archive chat",
        reason,
      );
    },
    [actions, confirmArchive, reportFailure],
  );

  const remove = useCallback(
    async (handle: HostThreadRef, heading: string) => {
      const apiClient = readLocalApi();
      if (confirmDelete && apiClient) {
        const ok = await apiClient.dialogs.confirm(
          `Delete chat "${heading}"?\nThis permanently deletes the chat from Kora. It can't be undone.`,
          { variant: "destructive", confirmLabel: "Delete" },
        );
        if (!ok) return;
      }
      const result = await actions.deleteThread(handle);
      if (result._tag === "Success" || isAtomActionInterrupted(result)) return;
      // A failure after the thread is gone was a worktree cleanup, which is toasted on its own.
      if (readThreadSummary(handle) !== null) {
        errorToast("Failed to delete chat", squashAtomActionFailure(result));
      }
    },
    [actions, confirmDelete],
  );

  const openMenu = useCallback(
    (place: { x: number; y: number }) => {
      const apiClient = readLocalApi();
      if (!threadRef || !apiClient) return;
      const sh = readThreadSummary(threadRef);
      if (!sh) return;

      const clock = new Date();
      const nowIso = clock.toISOString();
      const supports = {
        settlement: readHostSupportsSettlement(threadRef.hostId),
        snooze: readHostSupportsSnooze(threadRef.hostId),
        pinning: readHostSupportsPinning(threadRef.hostId),
        titleRegeneration: readHostSupportsTitleRegeneration(threadRef.hostId),
      };
      const proj = readProjects().find(
        (candidate) => candidate.hostId === sh.hostId && candidate.id === sh.projectId,
      );
      const elems = buildThreadActionMenuItems({
        surface: projectSurface(proj),
        branch: sh.branch,
        isPinned: sh.pinnedAt != null,
        isSettled: supports.settlement && sh.settledOverride === "settled",
        isSnoozed: supports.snooze && effectiveSnoozed(sh, { now: nowIso }),
        canSnoozeNow: canSnooze(sh, { now: nowIso }),
        isRegeneratingTitle: sh.titleRegeneration != null,
        isRunning: sh.session?.status === "running" && !!sh.session.activeTurnId,
        supports,
        snoozePresets: resolveSnoozePresets(clock, getClientPrefs().timestampFormat),
      });

      void apiClient.contextMenu.show<ThreadActionMenuId>(elems, place).then(
        async (choice) => {
          if (!choice) return;
          const handle = threadRef;
          const heading = sh.title;
          const verdict = (res: Outcome, failTitle: string) => reportFailure(res, failTitle);

          if (choice === "snooze:custom" || choice.startsWith("snooze:")) {
            await snooze(handle, choice);
            return;
          }
          switch (choice) {
            case "project-settings":
              if (proj) {
                void navigate({
                  to: "/projects/$projectKey",
                  // The route key is host:project, not the sidebar's grouping key.
                  params: { projectKey: `${proj.hostId}:${proj.id}` },
                });
              }
              return;
            case "new-thread-on-branch":
              if (!proj) return;
              openNewThread(hostProjectRef(proj.hostId, proj.id), {
                branch: sh.branch,
                worktreePath: sh.worktreePath,
                envMode: sh.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }).catch((err) => errorToast("Could not create chat", err));
              return;
            case "settle":
              verdict(await actions.settleThread(handle), "Could not mark the chat done");
              return;
            case "unsettle":
              verdict(await actions.unsettleThread(handle), "Could not reopen the chat");
              return;
            case "unsnooze":
              verdict(await actions.unsnoozeThread(handle), "Could not bring the chat back");
              return;
            case "pin":
              verdict(await actions.pinThread(handle), "Failed to pin chat");
              return;
            case "unpin":
              verdict(await actions.confirmAndUnpinThread(handle), "Failed to unpin chat");
              return;
            case "rename": {
              onStartRename();
              return;
            }
            case "regenerate-title":
              if (sh.titleRegeneration != null) return;
              verdict(
                await updateMetadata({
                  hostId: handle.hostId,
                  input: { threadId: handle.threadId, regenerateTitle: true },
                }),
                "Failed to regenerate chat title",
              );
              return;
            case "mark-unread":
              useViewStateStore
                .getState()
                .markThreadUnread(hostThreadKey(handle), sh.latestTurn?.completedAt);
              return;
            case "copy-path": {
              const loc = sh.worktreePath ?? projectCwd;
              if (!loc) {
                toastManager.add({
                  description: "This chat has no folder path to copy.",
                  title: "Path unavailable",
                  type: "error",
                });
                return;
              }
              copy(loc, "path", "Path copied", loc, "Failed to copy path");
              return;
            }
            case "copy-branch":
              if (sh.branch) {
                copy(sh.branch, "branch name", "Branch copied", sh.branch, "Failed to copy branch");
              }
              return;
            case "copy-thread-id":
              copy(
                handle.threadId,
                "chat ID",
                "Chat ID copied",
                handle.threadId,
                "Failed to copy chat ID",
              );
              return;
            case "archive":
              await archive(handle, heading);
              return;
            case "delete":
              await remove(handle, heading);
              return;
            default:
              return;
          }
        },
        () => undefined,
      );
    },
    [
      actions,
      archive,
      copy,
      navigate,
      onStartRename,
      openNewThread,
      projectCwd,
      reportFailure,
      remove,
      snooze,
      threadRef,
      updateMetadata,
    ],
  );

  const closeMenu = useCallback(() => {
    readLocalApi()?.contextMenu.close();
  }, []);

  return { openMenu, closeMenu };
}
