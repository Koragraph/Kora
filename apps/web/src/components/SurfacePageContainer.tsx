import { cn } from "../util/utils";
import type { ComponentPropsWithoutRef } from "react";

export type WorkspacePageWidth = "readable" | "expanded" | "wide";

const WIDTH_CLASS: Record<WorkspacePageWidth, string> = {
  expanded: "max-w-6xl",
  wide: "max-w-5xl",
  readable: "max-w-4xl",
};

const surfacePageContainerCls1 = "mx-auto flex w-full flex-col gap-6 px-5 pt-6 pb-12 sm:px-6";

/** Shared content frame for workspace pages. */
export function SurfacePageContainer({
  width = "readable",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & { readonly width?: WorkspacePageWidth }) {
  return <div className={cn(surfacePageContainerCls1, WIDTH_CLASS[width], className)} {...props} />;
}
