/** A removed CTA arrives as an `actionProps` object whose `children` is emptied. */

import type { HostThreadRef, ThreadId } from "@kora/contracts";

export function hasVisibleToastAction(actionProps: unknown): boolean {
  if (typeof actionProps !== "object" || actionProps === null) return false;
  if (!("children" in actionProps)) return false;
  const { children } = actionProps as { children: unknown };
  return children !== null && children !== false && children !== "" && children !== undefined;
}

/** The front toast stays readable even when the stack has been filtered down to one. */
export function shouldHideCollapsedToastContent(toastIndex: number, toastCount: number): boolean {
  return toastCount > 1 && toastIndex > 0;
}

type LayoutInput = {
  height?: number | null | undefined;
  transitionStatus?: "starting" | "ending" | undefined;
};

function normalizeHeight(height: number | null | undefined): number {
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : 0;
}

export function buildVisibleToastLayout<T extends object>(
  visibleToasts: readonly (T & LayoutInput)[],
): {
  frontmostHeight: number;
  items: { toast: T & LayoutInput; visibleIndex: number; offsetY: number }[];
} {
  // `full` counts every toast; `live` skips the ones on their way out, so the
  // survivors close the gap while the leaving toast animates from its old slot.
  let fullIndex = 0;
  let fullOffset = 0;
  let liveIndex = 0;
  let liveOffset = 0;
  let frontmostHeight: number | null = null;
  const items: { toast: T & LayoutInput; visibleIndex: number; offsetY: number }[] = [];

  for (const toast of visibleToasts) {
    const height = normalizeHeight(toast.height);
    const ending = toast.transitionStatus === "ending";
    if (ending) {
      items.push({ toast, visibleIndex: fullIndex, offsetY: fullOffset });
    } else {
      if (frontmostHeight === null) frontmostHeight = height;
      items.push({ toast, visibleIndex: liveIndex, offsetY: liveOffset });
      liveIndex += 1;
      liveOffset += height;
    }
    fullIndex += 1;
    fullOffset += height;
  }

  return { frontmostHeight: frontmostHeight ?? 0, items };
}

export function shouldRenderThreadScopedToast(
  data: { threadRef?: HostThreadRef | null; threadId?: ThreadId | null } | undefined,
  activeThreadRef: HostThreadRef | null,
): boolean {
  const scoped = data?.threadRef;
  if (scoped) {
    if (activeThreadRef === null) return false;
    return activeThreadRef.hostId === scoped.hostId && activeThreadRef.threadId === scoped.threadId;
  }
  if (!data?.threadId) return true;
  return activeThreadRef?.threadId === data.threadId;
}

export function withAnnouncementPriority<
  T extends { type?: string | undefined; priority?: "low" | "high" | undefined },
>(options: T): T {
  if (options.priority !== undefined) return options;
  if (options.type === "error" || options.type === "warning") {
    return { ...options, priority: "high" };
  }
  return options;
}
