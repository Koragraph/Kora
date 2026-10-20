import { toastManager } from "./ui/toast";
import { SwarmNotifications } from "./swarm/SwarmNotifications";
import { resolveNavThreadStatus } from "./NavRows.logic";
import {
  unlockNotificationAudio,
  hasShellNotifications,
  playNotificationSound,
  hasNotificationSound,
  setNotificationBadge,
} from "../thread/threadNotifications";
import { isHiddenThreadShell } from "../thread/hiddenThreads";
import { getClientPrefs, useClientPrefs } from "../hooks/usePrefs";
import { hostShell } from "../atoms/shell";
import { useHosts } from "../atoms/hosts";
import type { HostId } from "@kora/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import * as Option from "effect/Option";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";

type NoticeKind = "input" | "completion";
type PendingNotification = { readonly hostId: HostId; readonly notification: Notification };
type ThreadMemory = { attention: string | null; completion: number | null };
type OnNotification = (hostId: HostId, notification: Notification) => void;

const selectMode = (prefs: { notificationMode: string }) => prefs.notificationMode;
const selectInApp = (prefs: { inAppNotificationsEnabled: boolean }) =>
  prefs.inAppNotificationsEnabled;

const windowIsActive = () => document.visibilityState === "visible" && document.hasFocus();

export function TurnNotifications() {
  const mode = useClientPrefs(selectMode);
  const inApp = useClientPrefs(selectInApp);
  const { environments } = useHosts();
  const pending = useRef(new Map<string, PendingNotification>());

  const closeAll = useCallback(() => {
    for (const entry of pending.current.values()) entry.notification.close();
    pending.current.clear();
    setNotificationBadge(0);
  }, []);

  const track = useCallback<OnNotification>((hostId, notification) => {
    pending.current.get(notification.tag)?.notification.close();
    pending.current.set(notification.tag, { hostId, notification });
    setNotificationBadge(pending.current.size);
  }, []);

  // Everything outstanding is dropped when the mode changes and when the coordinator goes away.
  useEffect(() => closeAll, [mode, closeAll]);

  useEffect(() => {
    if (!hasShellNotifications(mode as never)) return;
    window.addEventListener("focus", closeAll);
    const unsubscribe = window.shellBridge?.onNotificationBadgeClear?.(closeAll);
    return () => {
      window.removeEventListener("focus", closeAll);
      unsubscribe?.();
    };
  }, [mode, closeAll]);

  useEffect(() => {
    if (!hasNotificationSound(mode as never)) return;
    const unlock = () => unlockNotificationAudio();
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, [mode]);

  const hostKey = environments.map((environment) => environment.hostId).join("\u0000");
  useEffect(() => {
    const present = new Set<string>(hostKey === "" ? [] : hostKey.split("\u0000"));
    let removed = false;
    for (const [tag, entry] of pending.current) {
      if (present.has(entry.hostId)) continue;
      entry.notification.close();
      pending.current.delete(tag);
      removed = true;
    }
    if (removed) setNotificationBadge(pending.current.size);
  }, [hostKey]);

  if (mode === "off" && !inApp) return null;
  return environments.map((environment) => (
    <HostNotifications
      key={environment.hostId}
      hostId={environment.hostId}
      onNotification={track}
    />
  ));
}

function titleFor(status: string): string {
  if (status === "ready") return "Chat completed";
  if (status === "approval") return "Approval needed";
  if (status === "failed") return "Chat failed";
  return "Input needed";
}

function HostNotifications({
  hostId,
  onNotification,
}: {
  readonly hostId: HostId;
  readonly onNotification: OnNotification;
}) {
  const shell = useAtomValue(hostShell.stateEntryAtom(hostId));
  const mode = useClientPrefs(selectMode);
  const inApp = useClientPrefs(selectInApp);
  const navigate = useNavigate();
  const open = useParams({ strict: false }) as { hostId?: string; threadId?: string };
  const memory = useRef(new Map<string, ThreadMemory>());

  const live = shell.status === "live" ? Option.getOrNull(shell.snapshot) : null;
  const threads = useMemo(
    () => (live ? live.threads.filter((thread) => !isHiddenThreadShell(thread)) : []),
    [live],
  );

  useEffect(() => {
    if (!live) {
      memory.current.clear();
      return;
    }
    const goToThread = (threadId: string) =>
      void navigate({ to: "/$hostId/$threadId", params: { hostId, threadId } as never });

    for (const thread of threads) {
      let status: string = resolveNavThreadStatus(thread);
      const turnState = thread.latestTurn?.state;
      if (status === "ready" && turnState === "error") status = "failed";

      const needsYou = status === "input" || status === "approval" || status === "failed";
      const attention = needsYou ? `${thread.latestTurn?.turnId ?? ""}:${status}` : null;
      const prior = memory.current.get(thread.id);
      const completedMs =
        status === "ready" && turnState === "completed" && thread.latestTurn?.completedAt
          ? Date.parse(thread.latestTurn.completedAt)
          : Number.NaN;
      const completion = Number.isFinite(completedMs) ? completedMs : (prior?.completion ?? null);
      memory.current.set(thread.id, { attention, completion });

      if (!prior || thread.archivedAt !== null) continue;

      let kind: NoticeKind | null = null;
      if (attention !== null && attention !== prior.attention) kind = "input";
      else if (
        completion !== null &&
        (prior.completion === null || completion > prior.completion)
      ) {
        kind = "completion";
      }
      if (!kind) continue;

      const title = titleFor(kind === "completion" ? "ready" : status);
      if (hasNotificationSound(mode as never)) {
        void playNotificationSound(kind, () =>
          hasNotificationSound(getClientPrefs().notificationMode as never),
        );
      }

      const isOpenThread = open.hostId === hostId && open.threadId === thread.id;
      if (inApp && windowIsActive() && !isOpenThread) {
        const toastId = toastManager.add({
          actionProps: {
            onClick: () => {
              toastManager.close(toastId);
              goToThread(thread.id);
            },
            children: "Open chat",
          },
          type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
          data: { hideCopyButton: true },
          description: thread.title,
          title,
        } as never);
        continue;
      }

      const canPopUp =
        typeof Notification !== "undefined" &&
        Notification.permission === "granted" &&
        hasShellNotifications(mode as never) &&
        !windowIsActive();
      if (!canPopUp) {
        continue;
      }
      try {
        const notification = new Notification(title, {
          body: thread.title,
          tag: `${hostId}:${thread.id}`,
          silent: true, // the sound is played separately
        });
        onNotification(hostId, notification);
        const focusThread = () => {
          notification.close();
          window.focus();
          goToThread(thread.id);
        };
        notification.addEventListener("click", focusThread);
      } catch {
        // A platform that refuses the constructor simply gets no popup.
      }
    }
  });

  if (!live) return null;
  return <SwarmNotifications hostId={hostId} threads={threads} onNotification={onNotification} />;
}
