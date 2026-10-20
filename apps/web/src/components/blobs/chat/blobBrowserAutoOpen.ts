// Show the blob's browser when it starts using it. A blob's first `browser_*` tool call in a turn (or a browser approval
// waiting on the owner) fires `show` once per turn per thread (the thread view pops the floating mini-window up,
// `browser/pip`): a user who closes it during that turn is left alone until the next turn. Pure signal + a small hook; no polling - it reads the
// thread activities the transcript already has.
import type { ChatThreadActivity } from "@kora/contracts";
import { useEffect, useRef } from "react";

import type { BlobPanelTab } from "./blobPanelStore";

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** `browser_navigate`, `mcp__kora-blob__browser_click`, ... */
// Also "kora_blobs: browser_navigate" (an ACP engine's tool title) and "Kora blobs.browser_click" (a title with spaces).
const BROWSER_TOOL = /(?:^|__|\.|:|\/|\s)browser_[a-z_]+\b/;

export function isBrowserToolName(name: unknown): boolean {
  return typeof name === "string" && BROWSER_TOOL.test(name);
}

function isBrowserApproval(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  const args = rec(payload.args);
  return (
    payload.appName === "Browser" ||
    args?.appName === "Browser" ||
    (args?.kind === "app-action" && args.tool === "browser")
  );
}

/**
 * The turn (its id, or "none") of the newest activity that shows the blob's browser at work: a `browser_*` tool call, or a
 * browser approval nobody answered yet. Null when the thread has none.
 */
export function latestBrowserSignalTurn(
  activities: ReadonlyArray<ChatThreadActivity>,
): string | null {
  const resolved = new Set<string>();
  for (const a of activities) {
    if (a.kind !== "approval.resolved") continue;
    const id = rec(a.payload)?.requestId;
    if (typeof id === "string") resolved.add(id);
  }
  let best: { turn: string; at: string } | null = null;
  for (const a of activities) {
    const p = rec(a.payload);
    let hit = false;
    // The tool name rides the payload (`toolName`); some drivers only fill the activity's own summary (the tool's title).
    if (
      a.tone === "tool" &&
      a.kind !== "tool_result" &&
      (isBrowserToolName(p?.toolName) || (!p?.toolName && isBrowserToolName(a.summary)))
    )
      hit = true;
    else if (a.kind === "approval.requested" && isBrowserApproval(p)) {
      const id = p?.requestId;
      hit = !(typeof id === "string" && resolved.has(id));
    }
    if (hit && (best === null || a.createdAt >= best.at))
      best = { turn: a.turnId ?? "none", at: a.createdAt };
  }
  return best?.turn ?? null;
}

/** thread -> turns already handled (shown, or already on screen when the thread was first seen). Survives remounts. */
const handled = new Map<string, Set<string>>();

/** Pure decision, exported for tests: should the panel open now, and what is now handled. */
export function decideBrowserAutoOpen(input: {
  readonly threadKey: string;
  readonly signalTurn: string | null;
  readonly liveTurnId: string | null;
  readonly handled: Map<string, Set<string>>;
}): boolean {
  const { threadKey, signalTurn, liveTurnId } = input;
  let seen = input.handled.get(threadKey);
  if (!seen) {
    seen = new Set();
    input.handled.set(threadKey, seen);
    // First sight of a thread: browsing that already happened in a finished turn is history, not news.
    if (signalTurn !== null && signalTurn !== liveTurnId) seen.add(signalTurn);
  }
  if (signalTurn === null || seen.has(signalTurn)) return false;
  seen.add(signalTurn);
  return true;
}

/** @public Kept for tests and external callers (knip). */
export function resetBlobBrowserAutoOpenForTests(): void {
  handled.clear();
}

export function useBlobBrowserAutoOpen(input: {
  /** Null off a blob's own thread (chat, group): nothing happens. */
  readonly blobId: string | null;
  readonly threadKey: string | null;
  readonly activities: ReadonlyArray<ChatThreadActivity>;
  readonly liveTurnId: string | null;
  /** `turn` is the browsing turn's id ("none" when the driver gave none): one browsing session per turn. */
  readonly show: (tab: BlobPanelTab, turn: string) => void;
}): void {
  const showRef = useRef(input.show);
  showRef.current = input.show;
  const { blobId, threadKey, activities, liveTurnId } = input;
  useEffect(() => {
    if (blobId === null || threadKey === null) return;
    const signalTurn = latestBrowserSignalTurn(activities);
    if (
      signalTurn !== null &&
      decideBrowserAutoOpen({ threadKey, signalTurn, liveTurnId, handled })
    )
      showRef.current("computer", signalTurn);
  }, [blobId, threadKey, activities, liveTurnId]);
}
