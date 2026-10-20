import { anchoredToastManager } from "./toast";
import type { RefObject } from "react";

export const ANCHORED_COPY_TOAST_TIMEOUT_MS = 1000;

export function showAnchoredCopySuccessToast(ref: RefObject<HTMLButtonElement | null>) {
  if (!ref.current) {
    return;
  }
  anchoredToastManager.add({
    title: "Copied!",
    data: {
      tooltipStyle: true,
    },
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
    positionerProps: {
      anchor: ref.current,
    },
  });
}

export function showAnchoredCopyErrorToast(ref: RefObject<HTMLButtonElement | null>, error: Error) {
  if (!ref.current) {
    return;
  }
  anchoredToastManager.add({
    title: "Failed to copy",
    description: error.message,
    data: {
      tooltipStyle: true,
    },
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
    positionerProps: {
      anchor: ref.current,
    },
  });
}
