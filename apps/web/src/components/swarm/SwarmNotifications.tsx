/**
 * Swarm notifications, delivered like thread notifications (TurnNotifications mounts this per
 * host, with the same settings, sound, toast and desktop-notification paths). Calm by design: one
 * notification when a worker needs the human (a question, a failure, no free models), and one when a batch
 * of workers has all finished — never one per worker state flip.
 */

import {
  hasShellNotifications,
  playNotificationSound,
  hasNotificationSound,
} from "~/thread/threadNotifications";
import { getClientPrefs, useClientPrefs } from "~/hooks/usePrefs";
import { useHostQuery } from "~/atoms/query";
import { fleetHost } from "~/atoms/fleet";
import { isSwarmTaskSettled, deriveSwarmTasks, type SwarmTask } from "./swarmTasks";
import { toastManager } from "../ui/toast";
import type { ChatThreadHead, HostId } from "@kora/contracts";
import { useEffect, useMemo, useRef } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";

export interface SwarmNotice {
  readonly kind: "input" | "completion";
  /** Stable per happening, so a re-render never repeats it. */
  readonly key: string;
  readonly title: string;
  readonly body: string;
}

/**
 * What changed worth telling the human, between two readings of one thread's tasks. `prev` null = the first
 * reading (a baseline: nothing that was already true when the app opened is announced).
 */
export function swarmNotices(
  prev: ReadonlyArray<SwarmTask> | null,
  next: ReadonlyArray<SwarmTask>,
): SwarmNotice[] {
  if (prev === null) return [];
  const out: SwarmNotice[] = [];
  const before = new Map(prev.map((t) => [t.taskId, t]));
  for (const t of next) {
    const was = before.get(t.taskId);
    if (t.needsYou && !was?.needsYou) {
      out.push({
        kind: "input",
        key: `${t.taskId}:needs:${t.state}:${t.attempt}`,
        title: t.state === "failed" ? "Swarm task failed" : "Swarm worker needs you",
        body: `${t.title} — ${t.activity}`,
      });
    }
  }
  const wasLive = prev.some((t) => !isSwarmTaskSettled(t));
  const allSettled = next.length > 0 && next.every(isSwarmTaskSettled);
  if (wasLive && allSettled) {
    const passed = next.filter((t) => t.state === "passed" || t.state === "done").length;
    const failed = next.length - passed;
    out.push({
      kind: "completion",
      key: `settled:${next.map((t) => `${t.taskId}@${t.endedAt ?? 0}`).join(",")}`,
      title: next.length === 1 ? "Swarm task finished" : `${next.length} swarm tasks finished`,
      body: failed > 0 ? `${passed} done · ${failed} failed` : `${passed} done`,
    });
  }
  return out;
}

export function SwarmNotifications(props: {
  hostId: HostId;
  threads: ReadonlyArray<ChatThreadHead>;
  onNotification: (hostId: HostId, notification: Notification) => void;
}) {
  const swarmThreads = useMemo(
    () => props.threads.filter((t) => t.agentMode === "swarm" && !t.archivedAt),
    [props.threads],
  );
  return swarmThreads.map((thread) => (
    <SwarmThreadWatcher
      key={thread.id}
      hostId={props.hostId}
      thread={thread}
      onNotification={props.onNotification}
    />
  ));
}

function SwarmThreadWatcher({
  hostId,
  thread,
  onNotification,
}: {
  hostId: HostId;
  thread: ChatThreadHead;
  onNotification: (hostId: HostId, notification: Notification) => void;
}) {
  const snapshot = useHostQuery(fleetHost.snapshot({ hostId, input: { threadId: thread.id } })).data
    ?.snapshot;
  const mode = useClientPrefs((settings) => settings.notificationMode);
  const inApp = useClientPrefs((settings) => settings.inAppNotificationsEnabled);
  const navigate = useNavigate();
  const { hostId: activeHostId, threadId: activeThreadId } = useParams({ strict: false });
  const previous = useRef<SwarmTask[] | null>(null);
  const announced = useRef(new Set<string>());

  useEffect(() => {
    if (!snapshot) return;
    const tasks = deriveSwarmTasks(snapshot);
    const notices = swarmNotices(previous.current, tasks).filter(
      (n) => !announced.current.has(n.key),
    );
    previous.current = tasks;
    for (const notice of notices) {
      announced.current.add(notice.key);
      const open = () =>
        void navigate({ to: "/$hostId/$threadId", params: { hostId, threadId: thread.id } });
      if (hasNotificationSound(mode)) {
        void playNotificationSound(notice.kind, () =>
          hasNotificationSound(getClientPrefs().notificationMode),
        );
      }
      const focused = document.visibilityState === "visible" && document.hasFocus();
      if (focused) {
        // Looking at this thread already: the task list says it; no toast on top.
        if (!inApp || (activeHostId === hostId && activeThreadId === thread.id)) continue;
        const toastId = toastManager.add({
          actionProps: {
            onClick: () => {
              toastManager.close(toastId);
              open();
            },
            children: "Open chat",
          },
          type: notice.kind === "completion" ? "success" : "warning",
          description: `${thread.title}: ${notice.body}`,
          data: { hideCopyButton: true },
          title: notice.title,
        });
        continue;
      }
      if (
        !hasShellNotifications(mode) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      )
        continue;
      try {
        const notification = new Notification(notice.title, {
          body: `${thread.title}: ${notice.body}`,
          tag: `${hostId}:${thread.id}:swarm`,
          silent: true,
        });
        onNotification(hostId, notification);
        const onClick = () => {
          notification.close();
          window.focus();
          open();
        };
        notification.addEventListener("click", onClick);
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
  }, [
    activeHostId,
    activeThreadId,
    hostId,
    inApp,
    mode,
    navigate,
    onNotification,
    snapshot,
    thread.id,
    thread.title,
  ]);

  return null;
}
