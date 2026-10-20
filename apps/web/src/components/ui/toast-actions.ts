"use client";

import type { ThreadToastData } from "./toast";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type { ToastManagerAddOptions } from "@base-ui/react/toast";

export type StackedThreadToastOptions = {
  /** Merged into `data`; `actionLayout` is always forced to `"stacked-end"` by the helper. */
  actionVariant?: ThreadToastData["actionVariant"];
  type: "error" | "warning" | "success" | "info" | "loading";
  actionProps?: ComponentPropsWithoutRef<"button">;
  data?: Omit<ThreadToastData, "actionLayout">;
  priority?: "low" | "high";
  description?: ReactNode;
  title: ReactNode;
  timeout?: number;
};

/**
 * Defined `actionProps` that hide a previous toast CTA on `toastManager.update`.
 * Passing `actionProps: undefined` is a no-op because updates omit undefined keys.
 */
export const hiddenToastActionProps = { children: null } as const satisfies Pick<
  ComponentPropsWithoutRef<"button">,
  "children"
>;

/**
 * Thread toast using the stacked body + bottom action row (copy for errors, CTA on its own row).
 */
export function threadToast(
  config: StackedThreadToastOptions,
): ToastManagerAddOptions<ThreadToastData> {
  const { actionVariant, description, actionProps, priority, timeout, title, type, data } = config;

  // Helper-owned `actionLayout` must win over any caller-provided `data`, so it is
  // spread after the caller's data.
  const mergedData: ThreadToastData = {
    ...data,
    actionLayout: "stacked-end",
    ...(actionVariant === undefined ? {} : { actionVariant }),
  };

  return {
    title,
    type,
    data: mergedData,
    ...(description === undefined ? {} : { description }),
    ...(timeout === undefined ? {} : { timeout }),
    ...(priority === undefined ? {} : { priority }),
    ...(actionProps === undefined ? {} : { actionProps }),
  };
}
