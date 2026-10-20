import type { ChatThreadActivity, HostThreadRef } from "@kora/contracts";
import { isAtomActionInterrupted } from "@kora/client-runtime/store/runtime";
import { useEffect, useRef } from "react";

import { rememberThreadVisit } from "~/stores/webHistoryStore";
import { isWebSupportedInRuntime } from "~/stores/webStateStore";
import { webHost } from "~/atoms/preview";
import { useAtomAction } from "~/atoms/use-atom-command";

import { isWebUrl } from "./browserLinkTarget";
import { openUrlInWeb } from "./openFileInWeb";

/** The fleet MCP tool the agent calls to show the user a page (runtime session/fleet-tools.ts). */
const OPEN_WEB_TOOL = "kora_open_preview";

/** A call older than this when the thread is first seen is history (a reload, a thread switch),
 *  not a request to open the page now. */
const FRESH_CALL_MS = 60_000;

/** The URL of an agent's `kora_open_preview` call, or null for any other activity. */
function agentWebUrl(activity: ChatThreadActivity): string | null {
  if (activity.kind === "tool_result") return null;
  const payload = activity.payload as { toolName?: unknown; input?: { url?: unknown } } | null;
  const name = typeof payload?.toolName === "string" ? payload.toolName : "";
  if (name !== OPEN_WEB_TOOL && !name.endsWith(`__${OPEN_WEB_TOOL}`)) return null;
  const url = payload?.input?.url;
  return typeof url === "string" && isWebUrl(url) ? url : null;
}

/**
 * Opens the page in the in-app browser beside the thread whenever the agent calls
 * `kora_open_preview` — the way Claude Code pops a preview open on its own. Each call opens once;
 * calls that were already old when the thread loaded are skipped.
 */
export function useAgentWebOpens(
  threadRef: HostThreadRef | null,
  activities: ReadonlyArray<ChatThreadActivity>,
): void {
  const openPreview = useAtomAction(webHost.open, { reportFailure: false });
  const handled = useRef(new Set<string>());
  const seenThread = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    if (!threadRef || !isWebSupportedInRuntime()) return;
    const key = `${threadRef.hostId}:${threadRef.threadId}`;
    if (seenThread.current?.key !== key) seenThread.current = { key, at: Date.now() };
    const firstSeenAt = seenThread.current.at;
    for (const activity of activities) {
      if (handled.current.has(activity.id)) continue;
      const url = agentWebUrl(activity);
      if (url === null) continue;
      handled.current.add(activity.id);
      if (Date.parse(activity.createdAt) < firstSeenAt - FRESH_CALL_MS) continue;
      void openUrlInWeb({ threadRef, url, openPreview }).then((result) => {
        if (isAtomActionInterrupted(result) || result._tag !== "Success") return;
        rememberThreadVisit(threadRef, url);
      });
    }
  }, [activities, openPreview, threadRef]);
}
