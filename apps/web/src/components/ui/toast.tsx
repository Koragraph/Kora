"use client";

import { cn } from "~/util/utils";
import { usePromptDraftStore, DraftId } from "~/stores/promptDraftStore";
import { useCopyToClipboard } from "~/hooks/useCopyText";
import { TooltipTrigger, TooltipPopup, Tooltip } from "./tooltip";
import {
  shouldHideCollapsedToastContent,
  shouldRenderThreadScopedToast,
  withAnnouncementPriority,
  buildVisibleToastLayout,
  hasVisibleToastAction,
} from "./toast-layout";
import { Spinner } from "./spinner";
import { Button } from "./button";
import type { HostThreadRef, ThreadId, HostId } from "@kora/contracts";
import { hostThreadRef } from "@kora/client-runtime/host";
import {
  useEffect,
  useState,
  type ReactNode,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  useMemo,
} from "react";
import {
  TriangleAlertIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ChevronUpIcon,
  CheckIcon,
  CopyIcon,
  InfoIcon,
  XIcon,
} from "lucide-react";
import { useParams } from "@tanstack/react-router";
import { Toast } from "@base-ui/react/toast";
import type { ToastManager } from "@base-ui/react/toast";

type ActionVariant =
  | "destructive-outline"
  | "destructive"
  | "secondary"
  | "outline"
  | "default"
  | "ghost"
  | "link";

export type ThreadToastData = {
  additionalActions?: ReadonlyArray<{ id: string; props: ComponentPropsWithoutRef<"button"> }>;
  secondaryActionProps?: ComponentPropsWithoutRef<"button">;
  expandableLabels?: { expand?: string; collapse?: string };
  actionLayout?: "inline" | "stacked-end";
  secondaryActionVariant?: ActionVariant;
  expandableDescriptionTrigger?: boolean;
  threadRef?: HostThreadRef | null;
  onClose?: (() => void) | undefined;
  dismissAfterVisibleMs?: number;
  expandableContent?: ReactNode;
  actionVariant?: ActionVariant;
  threadId?: ThreadId | null;
  hideCopyButton?: boolean;
  leadingIcon?: ReactNode;
  tooltipStyle?: boolean;
};

export type ToastPosition =
  | "bottom-center"
  | "bottom-right"
  | "bottom-left"
  | "top-center"
  | "top-right"
  | "top-left";

function withPriority(manager: ToastManager<ThreadToastData>): ToastManager<ThreadToastData> {
  return {
    ...manager,
    add: (options) => manager.add(withAnnouncementPriority(options) as typeof options),
    update: (id, options) =>
      manager.update(id, withAnnouncementPriority(options) as typeof options),
  };
}

const toastManager = withPriority(Toast.createToastManager<ThreadToastData>());
const anchoredToastManager = withPriority(Toast.createToastManager<ThreadToastData>());

export { hiddenToastActionProps, threadToast } from "./toast-actions";
export type { StackedThreadToastOptions } from "./toast-actions";
export { toastManager, anchoredToastManager };

// ---------------------------------------------------------------------------
// Thread scoping

function useActiveThreadRef(): HostThreadRef | null {
  const params = useParams({ strict: false }) as {
    hostId?: string;
    threadId?: string;
    draftId?: string;
  };
  const draftId = params.draftId ? DraftId.make(params.draftId) : null;
  const draft = usePromptDraftStore((store) => (draftId ? store.getDraftSession(draftId) : null));

  return useMemo(() => {
    if (params.hostId && params.threadId) {
      return hostThreadRef(params.hostId as HostId, params.threadId as ThreadId);
    }
    if (draft) return hostThreadRef(draft.hostId, draft.threadId);
    return null;
  }, [params.hostId, params.threadId, draft]);
}

// ---------------------------------------------------------------------------
// Auto-dismiss that only runs while the window is visible and focused

const remainingMsByToast = new Map<string, number>();

function windowIsAttended(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function VisibleDismissTimer({ toastId, totalMs }: { toastId: string; totalMs: number }) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let startedAt = 0;
    let remaining = remainingMsByToast.get(toastId) ?? totalMs;

    const pause = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
      remainingMsByToast.set(toastId, remaining);
    };
    const resume = () => {
      if (timer !== null || !windowIsAttended()) return;
      startedAt = Date.now();
      timer = setTimeout(() => {
        timer = null;
        remainingMsByToast.delete(toastId);
        toastManager.close(toastId);
      }, remaining);
    };
    const sync = () => (windowIsAttended() ? resume() : pause());

    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      pause();
    };
  }, [toastId, totalMs]);
  return null;
}

// ---------------------------------------------------------------------------
// Shared body pieces

function TypeIcon({ type }: { type: string | undefined }) {
  switch (type) {
    case "error":
      return <CircleAlertIcon className="text-destructive" />;
    case "info":
      return <InfoIcon className="text-info" />;
    case "loading":
      return <Spinner className="opacity-80" />;
    case "success":
      return <CircleCheckIcon className="text-success" />;
    case "warning":
      return <TriangleAlertIcon className="text-warning" />;
    default:
      return null;
  }
}

function CopyErrorButton({ text }: { text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>();
  const label = isCopied ? "Copied error" : "Copy error";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            onClick={() => copyToClipboard(text, undefined)}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        {isCopied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function DismissButton({
  data,
  toastId,
  manager,
}: {
  data: ThreadToastData | undefined;
  toastId: string;
  manager: ToastManager<ThreadToastData>;
}) {
  return (
    <div className="absolute top-2 right-2 z-20" data-slot="toast-close-slot">
      <button
        aria-label="Dismiss notification"
        className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        data-slot="toast-close"
        onClick={() => {
          data?.onClose?.();
          manager.close(toastId);
        }}
        type="button"
      >
        <XIcon className="size-3" strokeWidth={2.25} />
      </button>
    </div>
  );
}

function ExpandChevron({ open }: { open: boolean }) {
  const Icon = open ? ChevronUpIcon : ChevronDownIcon;
  return <Icon className="size-3.5 opacity-80" strokeWidth={2.25} />;
}

type ToastObject = ReturnType<typeof Toast.useToastManager<ThreadToastData>>["toasts"][number];

function ToastBody({
  toast,
  manager,
  anchored,
}: {
  toast: ToastObject;
  manager: ToastManager<ThreadToastData>;
  anchored: boolean;
}) {
  const data = toast.data;
  const [expanded, setExpanded] = useState(false);
  const description = toast.description;
  const descriptionText = typeof description === "string" ? description : null;
  const isError = toast.type === "error";
  const clampDescription = isError && descriptionText !== null && descriptionText.length >= 180;
  const stacked = data?.actionLayout === "stacked-end" && hasVisibleToastAction(toast.actionProps);
  const showCopy = isError && descriptionText !== null && !data?.hideCopyButton;
  const showPrimary = hasVisibleToastAction(toast.actionProps);
  const additional = data?.additionalActions ?? [];
  const hasControls =
    showCopy || additional.length > 0 || data?.secondaryActionProps !== undefined || showPrimary;

  const expandLabels = data?.expandableLabels;
  const actionLabel = expanded
    ? (expandLabels?.collapse ?? "Hide details")
    : (expandLabels?.expand ?? "Show details");
  const hasExpandable = data?.expandableContent !== undefined && data.expandableContent !== null;
  const descriptionIsTrigger = hasExpandable && data?.expandableDescriptionTrigger === true;

  const toggle = () => setExpanded((value) => !value);

  const descriptionNode =
    description !== undefined && description !== null && description !== "" ? (
      descriptionIsTrigger ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                aria-expanded={expanded}
                aria-label={actionLabel}
                className="group/desc -mx-1 flex cursor-pointer items-start gap-1 rounded-md px-1 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={toggle}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggle();
                  }
                }}
                role="button"
                tabIndex={0}
              />
            }
          >
            <Toast.Description
              className="min-w-0 flex-1 select-text break-words text-muted-foreground group-hover/desc:underline"
              data-slot="toast-description"
            />
            <ExpandChevron open={expanded} />
          </TooltipTrigger>
          <TooltipPopup side="top">{actionLabel}</TooltipPopup>
        </Tooltip>
      ) : (
        <Toast.Description
          className={cn(
            "select-text break-words text-muted-foreground",
            clampDescription && "line-clamp-4",
          )}
          data-slot="toast-description"
        />
      )
    ) : null;

  const controls = hasControls ? (
    <div
      className={cn("flex items-center gap-1.5", stacked ? "w-full justify-end" : "shrink-0")}
      data-slot="toast-controls"
    >
      {showCopy ? <CopyErrorButton text={descriptionText ?? ""} /> : null}
      {additional.map((action) => (
        <Button
          key={action.id}
          size="xs"
          variant={data?.secondaryActionVariant ?? "outline"}
          {...action.props}
        />
      ))}
      {data?.secondaryActionProps ? (
        <Button
          size="xs"
          variant={data.secondaryActionVariant ?? "outline"}
          {...data.secondaryActionProps}
        />
      ) : null}
      {showPrimary ? (
        <Toast.Action
          data-slot="toast-action"
          render={<Button size="xs" variant={data?.actionVariant ?? "default"} />}
        />
      ) : null}
    </div>
  ) : null;

  const textColumn = (
    <div className={cn("min-w-0 flex-1", stacked && "pr-5")}>
      <Toast.Title className="toast-title font-medium" data-slot="toast-title" />
      {descriptionNode}
      {hasExpandable && !descriptionIsTrigger ? (
        <button
          aria-expanded={expanded}
          className="mt-1 inline-flex cursor-pointer items-center gap-1 font-medium text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={toggle}
          type="button"
        >
          {actionLabel}
          <ExpandChevron open={expanded} />
        </button>
      ) : null}
      {hasExpandable && expanded ? (
        <div className="mt-2 max-h-40 select-text overflow-y-auto overscroll-contain">
          {data?.expandableContent}
        </div>
      ) : null}
    </div>
  );

  if (anchored && data?.tooltipStyle) {
    return (
      <div className="px-2 py-1" data-slot="toast-body">
        <Toast.Title data-slot="toast-title" />
      </div>
    );
  }

  const leading = data?.leadingIcon ?? <TypeIcon type={toast.type} />;
  const dismissPad = "pr-10";

  return (
    <>
      <DismissButton data={data} manager={manager} toastId={toast.id} />
      <div
        className={cn(
          "text-sm",
          anchored ? "pl-3.5" : "pl-4",
          stacked
            ? cn("flex flex-col gap-2 py-2.5", dismissPad)
            : cn("flex items-center gap-1.5 py-3", dismissPad),
        )}
        data-slot="toast-body"
      >
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <div className="w-4 shrink-0 [&_svg]:pointer-events-none [&_svg]:size-4 leading-tight">
            {leading}
          </div>
          {textColumn}
        </div>
        {controls}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Stacked viewport

const POSITION_CLASS: Record<ToastPosition, string> = {
  "top-left": "top-(--toast-top) left-(--toast-inset)",
  "top-center": "top-(--toast-top) left-1/2 -translate-x-1/2",
  "top-right": "top-(--toast-top) right-(--toast-inset)",
  "bottom-left": "bottom-(--toast-inset) left-(--toast-inset)",
  "bottom-center": "bottom-(--toast-inset) left-1/2 -translate-x-1/2",
  "bottom-right": "bottom-(--toast-inset) right-(--toast-inset)",
};

function swipeDirections(position: ToastPosition): ("up" | "down" | "left" | "right")[] {
  const vertical = position.startsWith("top") ? "up" : "down";
  if (position.endsWith("center")) return [vertical];
  return [position.endsWith("left") ? "left" : "right", vertical];
}

const ROOT_CLASS = [
  "dropdown-glass group/toast absolute z-(--toast-z) w-full select-none overflow-visible rounded-lg text-popover-foreground shadow-xl shadow-black/25",
  "h-auto origin-(--toast-origin) [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s]",
  // left status stripe
  "before:pointer-events-none before:absolute before:top-2.5 before:bottom-2.5 before:left-1.5 before:w-0.5 before:rounded-full before:bg-foreground/35",
  "data-[type=error]:before:bg-destructive data-[type=warning]:before:bg-warning data-[type=success]:before:bg-success",
  // bridge the gap between toasts so hover stays active
  "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
  // collapsed stack
  "[transform:translateX(var(--toast-swipe-movement-x,0px))_translateY(calc(var(--toast-swipe-movement-y,0px)+var(--toast-dir)*(var(--toast-slot)*var(--toast-peek)+(1-var(--toast-scale))*var(--toast-frontmost-height,0px))))_scale(var(--toast-scale))]",
  // expanded stack
  "data-expanded:[transform:translateX(var(--toast-swipe-movement-x,0px))_translateY(calc(var(--toast-swipe-movement-y,0px)+var(--toast-dir)*(var(--toast-slot-offset)+var(--toast-slot)*var(--toast-gap))))]",
  "data-limited:opacity-0",
  // enter
  "data-starting-style:[transform:translateY(calc((-100%-var(--toast-inset))*var(--toast-dir)))]",
  // exit
  "data-ending-style:opacity-0",
  "data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--toast-swipe-movement-y,0px))]",
  "data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--toast-swipe-movement-y,0px))]",
  "data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
  "data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
].join(" ");

function Toasts({ position }: { position: ToastPosition }) {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const activeThreadRef = useActiveThreadRef();
  const top = position.startsWith("top");
  const topRight = position === "top-right";

  const visible = useMemo(
    () => toasts.filter((item) => shouldRenderThreadScopedToast(item.data, activeThreadRef)),
    [toasts, activeThreadRef],
  );
  const layout = useMemo(() => buildVisibleToastLayout(visible), [visible]);

  useEffect(() => {
    const live = new Set(toasts.map((item) => item.id));
    for (const id of remainingMsByToast.keys()) {
      if (!live.has(id)) remainingMsByToast.delete(id);
    }
  }, [toasts]);

  const viewportStyle = {
    "--toast-inset": "1rem",
    "--toast-top": "calc(var(--toast-inset) + var(--workspace-topbar-height, 0px))",
    "--toast-gap": "0.75rem",
    "--toast-peek": "0.75rem",
    "--toast-dir": top ? 1 : -1,
    "--toast-frontmost-height": `${layout.frontmostHeight}px`,
  } as CSSProperties;

  const toastViewportPart = (
    <Toast.Viewport
      className={cn(
        "fixed z-100 w-[calc(100%-2*var(--toast-inset))] max-w-90 sm:[--toast-inset:2rem]",
        POSITION_CLASS[position],
      )}
      data-slot="toast-viewport"
      style={viewportStyle}
    >
      {layout.items.map(({ toast, visibleIndex, offsetY }) => {
        const data = toast.data;
        const scale = Math.max(0, 1 - visibleIndex * 0.1);
        const hideContent = shouldHideCollapsedToastContent(visibleIndex, visible.length);
        const itemStyle = {
          "--toast-slot": visibleIndex,
          "--toast-slot-offset": `${offsetY}px`,
          "--toast-scale": scale,
          "--toast-z": 9999 - visibleIndex,
          "--toast-origin": top ? "top center" : "bottom center",
          [top ? "top" : "bottom"]: 0,
        } as CSSProperties;

        const toastContentPart = (
          <Toast.Content
            className={cn(
              "pointer-events-auto min-h-0 overflow-x-clip overflow-y-visible transition-opacity duration-250",
              hideContent &&
                "pointer-events-none opacity-0 group-data-expanded/toast:pointer-events-auto group-data-expanded/toast:opacity-100",
            )}
            data-slot="toast-content"
          >
            <ToastBody anchored={false} manager={toastManager} toast={toast} />
          </Toast.Content>
        );

        return (
          <Toast.Root
            className={cn(
              ROOT_CLASS,
              top ? "after:top-full" : "after:bottom-full",
              topRight &&
                "data-starting-style:[transform:translateX(calc(100%+var(--toast-inset)))]",
              visibleIndex > 0 && "not-data-expanded:h-(--toast-frontmost-height)",
            )}
            data-slot="toast-root"
            key={toast.id}
            style={itemStyle}
            swipeDirection={swipeDirections(position)}
            toast={toast}
          >
            {data?.dismissAfterVisibleMs ? (
              <VisibleDismissTimer toastId={toast.id} totalMs={data.dismissAfterVisibleMs} />
            ) : null}
            {toastContentPart}
          </Toast.Root>
        );
      })}
    </Toast.Viewport>
  );

  return <Toast.Portal>{toastViewportPart}</Toast.Portal>;
}

export function ToastProvider({
  children,
  position = "top-center",
  ...props
}: Toast.Provider.Props & { position?: ToastPosition }) {
  const toastProviderKids = (
    <>
      {children}
      <Toasts position={position} />
    </>
  );

  return (
    <Toast.Provider toastManager={toastManager} {...props}>
      {toastProviderKids}
    </Toast.Provider>
  );
}

const anchoredToastsCls1 =
  "dropdown-glass relative overflow-visible text-balance text-popover-foreground text-xs shadow-xl shadow-black/25 transition-[scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0";

// ---------------------------------------------------------------------------
// Anchored toasts

function AnchoredToasts() {
  const { toasts } = Toast.useToastManager<ThreadToastData>();

  const toastViewportPart2 = (
    <Toast.Viewport data-slot="toast-anchored-viewport">
      {toasts.map((toast) => {
        const positionerProps = toast.positionerProps;
        if (!positionerProps?.anchor) return null;
        const tooltipStyle = toast.data?.tooltipStyle === true;

        const toastContentPart2 = (
          <Toast.Content className="pointer-events-auto min-h-0 overflow-x-clip overflow-y-visible">
            <ToastBody anchored manager={anchoredToastManager} toast={toast} />
          </Toast.Content>
        );

        const toastRootPart = (
          <Toast.Root
            className={cn(anchoredToastsCls1, tooltipStyle ? "rounded-md" : "rounded-lg")}
            data-slot="toast-root"
            toast={toast}
          >
            {toastContentPart2}
          </Toast.Root>
        );

        return (
          <Toast.Positioner
            className="z-100 max-w-[min(16rem,var(--available-width))]"
            sideOffset={positionerProps.sideOffset ?? 4}
            data-slot="toast-positioner"
            key={toast.id}
            toast={toast}
            {...positionerProps}
          >
            {toastRootPart}
          </Toast.Positioner>
        );
      })}
    </Toast.Viewport>
  );

  return <Toast.Portal>{toastViewportPart2}</Toast.Portal>;
}

export function AnchoredToastProvider({ children, ...props }: Toast.Provider.Props) {
  const toastProviderKids2 = (
    <>
      {children}
      <AnchoredToasts />
    </>
  );

  return (
    <Toast.Provider toastManager={anchoredToastManager} {...props}>
      {toastProviderKids2}
    </Toast.Provider>
  );
}
