"use client";

import { cn } from "~/util/utils";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { useDragResize } from "~/hooks/useDragResize";
import { TooltipTrigger, TooltipPopup, Tooltip } from "./tooltip";
import { Skeleton } from "./skeleton";
import { Separator } from "./separator";
import { ScrollArea } from "./scroll-area";
import { resolveSidebarState } from "./navState";
import { Input } from "./input";
import { Button } from "./button";
import { createPortal } from "react-dom";
import * as React from "react";
import { PanelLeftCloseIcon, PanelLeftIcon } from "lucide-react";
import { Schema } from "effect";
import { type VariantProps, cva } from "class-variance-authority";
import { useRender } from "@base-ui/react/use-render";
import { mergeProps } from "@base-ui/react/merge-props";

const DEFAULT_MIN_WIDTH = 256;
const COOKIE_NAME = "sidebar_state";
const COOKIE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

type SidebarSide = "left" | "right";

type SidebarResizableOptions = {
  shouldAcceptWidth?: (context: {
    sidebarRoot: HTMLElement;
    rail: HTMLButtonElement;
    wrapper: HTMLElement;
    currentWidth: number;
    side: SidebarSide;
    nextWidth: number;
  }) => boolean;
  onResize?: (width: number) => void;
  storageKey?: string;
  minWidth?: number;
  maxWidth?: number;
};

type SidebarContextValue = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

// What the shell tells its rail: which edge, whether it may be dragged, and where to mount.
type SidebarShellValue = {
  side: SidebarSide;
  resizable: boolean | SidebarResizableOptions | undefined;
  container: HTMLElement | null;
};

const SidebarShellContext = React.createContext<SidebarShellValue | null>(null);

function useSidebar(): SidebarContextValue {
  const context = React.useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used within a SidebarProvider.");
  return context;
}

/** The sidebar's open/close toggle, for keyboard shortcuts outside the trigger. */
function useSidebarToggle(): () => void {
  return useSidebar().toggleSidebar;
}

function useSidebarVisibility(): boolean {
  return useSidebar().open;
}

function rememberOpenState(open: boolean) {
  if (typeof cookieStore === "undefined") return;
  void cookieStore
    .set({
      name: COOKIE_NAME,
      value: String(open),
      path: "/",
      expires: Date.now() + COOKIE_LIFETIME_MS,
    })
    .catch(() => undefined);
}

function SidebarProvider(
  incoming: React.ComponentProps<"div"> & {
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
    open?: boolean;
  },
) {
  const {
    defaultOpen = true,
    open: openProp,
    onOpenChange,
    className,
    children,
    style,
    ...props
  } = incoming;
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const open = openProp ?? internalOpen;

  const setOpen = React.useCallback(
    (value: boolean | ((current: boolean) => boolean)) => {
      const next = typeof value === "function" ? value(open) : value;
      if (onOpenChange) onOpenChange(next);
      else setInternalOpen(next);
      rememberOpenState(next);
    },
    [open, onOpenChange],
  );

  const toggleSidebar = React.useCallback(() => setOpen((current) => !current), [setOpen]);
  const state = resolveSidebarState({ open });

  const contextValue = React.useMemo<SidebarContextValue>(
    () => ({ state, open, setOpen, toggleSidebar }),
    [state, open, setOpen, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        className={cn(
          "group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar",
          className,
        )}
        data-sidebar-state={state}
        data-slot="sidebar-wrapper"
        style={
          {
            "--sidebar-width": "16rem",
            "--sidebar-width-icon": "3rem",
            "--workspace-titlebar-content-left":
              "calc(var(--workspace-controls-left) + var(--workspace-titlebar-control-size) + var(--workspace-titlebar-control-gap) + var(--workspace-titlebar-extra-left, 0px))",
            ...style,
          } as React.CSSProperties
        }
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

// ---- drag-to-resize rail ---------------------------------------------------

function clampWidth(width: number, min: number, max: number | undefined): number {
  const floor = Math.max(width, min);
  return max === undefined ? floor : Math.min(floor, max);
}

function SidebarRail({
  className,
  resizable: resizableProp,
  side: sideProp,
  ...props
}: React.ComponentProps<"button"> & {
  resizable?: boolean | SidebarResizableOptions;
  side?: SidebarSide;
}) {
  const { open, toggleSidebar } = useSidebar();
  const shell = React.useContext(SidebarShellContext);
  const side = sideProp ?? shell?.side ?? "left";
  const resizable = resizableProp ?? shell?.resizable;
  const railRef = React.useRef<HTMLButtonElement | null>(null);
  const suppressClickRef = React.useRef(false);

  const options: SidebarResizableOptions | null =
    resizable === true ? {} : resizable ? resizable : null;
  const minWidth = options?.minWidth ?? DEFAULT_MIN_WIDTH;
  const maxWidth = options?.maxWidth;
  const storageKey = options?.storageKey;
  const onResize = options?.onResize;
  const shouldAcceptWidth = options?.shouldAcceptWidth;
  const canResize = options !== null && open;

  // Put the remembered width back before the first paint.
  React.useLayoutEffect(() => {
    if (!storageKey) return;
    const rail = railRef.current;
    const wrapper = rail?.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    if (!wrapper) return;
    try {
      const stored = getLocalStorageItem(storageKey, Schema.Finite);
      if (stored === null) return;
      const width = clampWidth(stored, minWidth, maxWidth);
      wrapper.style.setProperty("--sidebar-width", `${width}px`);
      onResize?.(width);
    } catch (error) {
      console.error("Could not restore persisted sidebar width.", error);
    }
  }, [storageKey, minWidth, maxWidth]);

  const dragHandlers = useDragResize<HTMLButtonElement>((event) => {
    if (!canResize) return null;
    const rail = event.currentTarget;
    const sidebarRoot = rail.closest<HTMLElement>("[data-slot='sidebar']");
    const wrapper = rail.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    const container = sidebarRoot?.querySelector<HTMLElement>("[data-slot='sidebar-container']");
    const gap = sidebarRoot?.querySelector<HTMLElement>("[data-slot='sidebar-gap']");
    if (!wrapper || !sidebarRoot || !container) return null;

    const startWidth = clampWidth(
      sidebarRoot.getBoundingClientRect().width || container.getBoundingClientRect().width,
      minWidth,
      maxWidth,
    );
    let applied = startWidth;
    suppressClickRef.current = false;

    const previousGapDuration = gap?.style.transitionDuration ?? "";
    const previousContainerDuration = container.style.transitionDuration;
    if (gap) gap.style.transitionDuration = "0ms";
    container.style.transitionDuration = "0ms";

    return {
      width: startWidth,
      edge: side === "left" ? "right" : "left",
      resize: (requested) => {
        const next = clampWidth(requested, minWidth, maxWidth);
        const accepted =
          shouldAcceptWidth?.({
            currentWidth: applied,
            nextWidth: next,
            rail,
            side,
            sidebarRoot,
            wrapper,
          }) ?? true;
        if (accepted) {
          applied = next;
          wrapper.style.setProperty("--sidebar-width", `${next}px`);
        }
        return applied;
      },
      finish: (width, moved) => {
        if (moved) suppressClickRef.current = true;
        if (storageKey) {
          try {
            setLocalStorageItem(storageKey, width, Schema.Finite);
          } catch (error) {
            console.error("Could not persist sidebar width.", error);
          }
        }
        onResize?.(width);
      },
      cleanup: () => {
        if (gap) gap.style.transitionDuration = previousGapDuration;
        container.style.transitionDuration = previousContainerDuration;
      },
    };
  }, storageKey);

  const label = canResize ? "Resize Sidebar" : "Toggle Sidebar";
  const hint = canResize ? "Drag to resize sidebar" : "Toggle Sidebar";

  const rail = (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            className={cn(
              "absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-all ease-linear after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border sm:flex",
              side === "left" ? "-right-4" : "left-0",
              side === "left"
                ? "cursor-w-resize group-data-[collapsible=offcanvas]:cursor-e-resize"
                : "cursor-e-resize group-data-[collapsible=offcanvas]:cursor-w-resize",
              "group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full group-data-[collapsible=offcanvas]:pointer-events-none",
              side === "left"
                ? "group-data-[collapsible=offcanvas]:-right-2"
                : "group-data-[collapsible=offcanvas]:-left-2",
              "in-[[data-panel-animations=true]]:duration-(--panel-animation-duration)",
              className,
            )}
            aria-label={label}
            data-slot="sidebar-rail"
            data-sidebar="rail"
            ref={railRef}
            type="button"
            tabIndex={-1}
            onClick={(event) => {
              props.onClick?.(event);
              if (suppressClickRef.current) {
                event.preventDefault();
                suppressClickRef.current = false;
                return;
              }
              if (event.defaultPrevented) return;
              if (canResize) {
                event.preventDefault();
                return;
              }
              toggleSidebar();
            }}
            {...dragHandlers}
          />
        }
      />
      <TooltipPopup side="right">{hint}</TooltipPopup>
    </Tooltip>
  );

  return shell?.container ? createPortal(rail, shell.container) : rail;
}

const sidebarCls1 = "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) md:flex";

// ---- sidebar shell ---------------------------------------------------------

function Sidebar({
  collapsible = "offcanvas",
  variant = "sidebar",
  side = "left",
  resizable,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  resizable?: boolean | SidebarResizableOptions;
  collapsible?: "offcanvas" | "icon" | "none";
  variant?: "sidebar" | "floating" | "inset";
  side?: SidebarSide;
}) {
  const { state } = useSidebar();
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  const shellValue = React.useMemo(
    () => ({ side, resizable, container }),
    [side, resizable, container],
  );

  if (collapsible === "none") {
    return (
      <div
        className={cn(
          "surface-grain flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground",
          className,
        )}
        data-slot="sidebar"
        {...props}
      >
        {children}
      </div>
    );
  }

  const insetLike = variant === "floating" || variant === "inset";
  const collapsedState = state === "collapsed";

  return (
    <div
      className="group peer hidden text-sidebar-foreground md:block"
      data-collapsible={collapsedState ? collapsible : ""}
      data-variant={variant}
      data-slot="sidebar"
      data-state={state}
      data-side={side}
    >
      <div
        data-slot="sidebar-gap"
        className={cn(
          "relative w-(--sidebar-width) bg-transparent",
          "group-data-[collapsible=offcanvas]:w-0",
          side === "right" && "rotate-180",
          "in-[[data-panel-animations=true]]:transition-[width] in-[[data-panel-animations=true]]:duration-(--panel-animation-duration) in-[[data-panel-animations=true]]:ease-out",
          insetLike
            ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+--spacing(4))]"
            : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
        )}
      />
      <div
        ref={setContainer}
        className={cn(
          sidebarCls1,
          side === "right"
            ? "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]"
            : "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]",
          "in-[[data-panel-animations=true]]:transition-[left,right,width] in-[[data-panel-animations=true]]:duration-(--panel-animation-duration) in-[[data-panel-animations=true]]:ease-out",
          insetLike
            ? "py-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+--spacing(4)+2px)]"
            : cn(
                "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
                side === "left" ? "border-r" : "border-l",
              ),
          className,
        )}
        data-slot="sidebar-container"
        {...props}
      >
        <div
          className={cn(
            "surface-grain flex size-full flex-col bg-sidebar",
            variant === "floating" && "overflow-hidden rounded-(--surface-radius)",
          )}
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
        >
          <SidebarShellContext.Provider value={shellValue}>{children}</SidebarShellContext.Provider>
        </div>
      </div>
    </div>
  );
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { open, toggleSidebar } = useSidebar();
  const Icon = open ? PanelLeftCloseIcon : PanelLeftIcon;
  return (
    <Button
      data-sidebar="trigger"
      variant="ghost"
      data-slot="sidebar-trigger"
      size="icon"
      onClick={(event) => {
        toggleSidebar();
        onClick?.(event);
      }}
      aria-pressed={open}
      className={cn(
        "size-[var(--workspace-titlebar-control-size)]! [-webkit-app-region:no-drag]",
        className,
      )}
      {...props}
    >
      <Icon />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      className={cn(
        "surface-grain relative flex min-w-0 flex-1 flex-col bg-background",
        "md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm/5 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2",
        className,
      )}
      data-slot="sidebar-inset"
      {...props}
    />
  );
}

function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      className={cn("h-8 w-full bg-background shadow-none", className)}
      data-sidebar="input"
      data-slot="sidebar-input"
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2 p-2", className)}
      data-slot="sidebar-header"
      data-sidebar="header"
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2 p-2", className)}
      data-sidebar="footer"
      data-slot="sidebar-footer"
      {...props}
    />
  );
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      className={cn("mx-2 w-auto bg-sidebar-border", className)}
      data-sidebar="separator"
      data-slot="sidebar-separator"
      {...props}
    />
  );
}

function SidebarContent({
  className,
  fixedHeader,
  children,
  ...props
}: React.ComponentProps<"div"> & { fixedHeader?: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {fixedHeader ? <div className="w-full shrink-0">{fixedHeader}</div> : null}
      <ScrollArea
        className="min-h-0 flex-1 [--fade-size:12px]"
        hideScrollbars
        scrollFade
        scrollFadePadding={false}
      >
        <div
          className={cn(
            "flex min-h-0 flex-col gap-2 [overflow-anchor:none] group-data-[collapsible=icon]:overflow-hidden",
            className,
          )}
          data-slot="sidebar-content"
          data-sidebar="content"
          {...props}
        >
          {children}
        </div>
      </ScrollArea>
    </div>
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("relative flex w-full min-w-0 flex-col p-(--sidebar-content-inset)", className)}
      data-sidebar="group"
      data-slot="sidebar-group"
      {...props}
    />
  );
}

function SidebarGroupLabel({ className, render, ...props }: useRender.ComponentProps<"div">) {
  const mergedProps = mergeProps<"div">(
    {
      className: cn(
        "flex h-8 shrink-0 items-center rounded-lg px-2 font-medium text-sidebar-foreground text-xs outline-none ring-sidebar-ring transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
        className,
      ),
      ...{ "data-sidebar": "group-label", "data-slot": "sidebar-group-label" },
    },
    props,
  );
  return useRender({ render, props: mergedProps, defaultTagName: "div" });
}

function SidebarGroupAction({ className, render, ...props }: useRender.ComponentProps<"button">) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(
          "absolute top-3.5 right-3 flex size-5 cursor-pointer items-center justify-center rounded-lg p-0 text-sidebar-foreground outline-none ring-sidebar-ring transition-transform hover:bg-sidebar-row-hover focus-visible:ring-2 after:absolute after:-inset-2 md:after:hidden group-data-[collapsible=icon]:hidden [&>svg]:size-4 [&>svg]:shrink-0",
          className,
        ),
        ...{ "data-sidebar": "group-action", "data-slot": "sidebar-group-action" },
      },
      props,
    ),
    render,
  });
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("w-full text-sm", className)}
      data-sidebar="group-content"
      data-slot="sidebar-group-content"
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      className={cn("flex w-full min-w-0 flex-col gap-1", className)}
      data-slot="sidebar-menu"
      data-sidebar="menu"
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      className={cn("group/menu-item relative", className)}
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      {...props}
    />
  );
}

const menuButtonVariants = cva(
  "peer/menu-button flex w-full cursor-pointer items-center gap-[var(--sidebar-control-gap)] overflow-hidden text-left text-sm outline-hidden ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-row-hover focus-visible:ring-2 active:bg-sidebar-row-active disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-row-selected data-[active=true]:font-medium data-popup-open:hover:bg-sidebar-row-hover group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-(--sidebar-content-inset)! [&>span:last-child]:truncate [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-[var(--sidebar-icon-color)] hover:[&_svg]:text-sidebar-foreground data-[active=true]:[&_svg]:text-sidebar-foreground",
  {
    variants: {
      variant: {
        default: "text-sidebar-foreground/75",
        outline:
          "bg-sidebar-control-surface ring-1 ring-sidebar-border dark:bg-(--lift-inset-bg) dark:shadow-(--lift-inset-shadow)",
      },
      size: {
        default:
          "h-8 rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] py-1.5 text-sm",
        icon: "size-8 justify-center rounded-[var(--control-radius)] p-0",
        lg: "h-12 rounded-lg p-2 group-data-[collapsible=icon]:p-0!",
        sm: "h-7 rounded-lg px-3 py-2 text-xs",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function SidebarMenuButton({
  variant = "default",
  size = "default",
  isActive = false,
  className,
  tooltip,
  render,
  ...props
}: useRender.ComponentProps<"button"> & {
  tooltip?: string | React.ComponentProps<typeof TooltipPopup>;
  isActive?: boolean;
} & VariantProps<typeof menuButtonVariants>) {
  const { state } = useSidebar();
  const button = useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(menuButtonVariants({ variant, size }), className),
        ...{
          "data-slot": "sidebar-menu-button",
          "data-sidebar": "menu-button",
          "data-active": isActive,
          "data-size": size,
        },
      },
      props,
    ),
    render: tooltip ? <TooltipTrigger render={render} /> : render,
  });

  if (!tooltip) return button;

  const popupProps = typeof tooltip === "string" ? { children: tooltip } : tooltip;
  return (
    <Tooltip>
      {button}
      <TooltipPopup align="center" hidden={state !== "collapsed"} side="right" {...popupProps} />
    </Tooltip>
  );
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute right-1 flex h-5 min-w-5 select-none items-center justify-center rounded-lg px-1 font-medium text-sidebar-foreground text-xs tabular-nums",
        "peer-data-[size=sm]/menu-button:top-1 peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      data-sidebar="menu-badge"
      data-slot="sidebar-menu-badge"
      {...props}
    />
  );
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<"div"> & { showIcon?: boolean }) {
  // One random label width per mount, so rows do not jitter on re-render.
  const [labelWidth] = React.useState(() => `${Math.floor(Math.random() * 40) + 50}%`);
  return (
    <div
      className={cn("flex h-8 items-center gap-2 rounded-lg px-2", className)}
      data-sidebar="menu-skeleton"
      data-slot="sidebar-menu-skeleton"
      {...props}
    >
      {showIcon && <Skeleton className="size-4 rounded-md" data-sidebar="menu-skeleton-icon" />}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={{ "--skeleton-width": labelWidth } as React.CSSProperties}
      />
    </div>
  );
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      className={cn(
        "mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-sidebar-border border-l px-2.5 py-0.5 group-data-[collapsible=icon]:hidden",
        className,
      )}
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      {...props}
    />
  );
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      className={cn("group/menu-sub-item relative", className)}
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      {...props}
    />
  );
}

function SidebarMenuSubButton({
  isActive = false,
  size = "md",
  className,
  render,
  ...props
}: useRender.ComponentProps<"a"> & { size?: "sm" | "md"; isActive?: boolean }) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        className: cn(
          "flex h-7 min-w-0 -translate-x-px cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 text-sidebar-foreground outline-hidden ring-sidebar-ring hover:bg-sidebar-row-hover focus-visible:ring-2 active:bg-sidebar-row-active disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-row-selected [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-muted-foreground",
          size === "sm" ? "text-xs" : "text-sm",
          "group-data-[collapsible=icon]:hidden",
          className,
        ),
        ...{
          "data-slot": "sidebar-menu-sub-button",
          "data-sidebar": "menu-sub-button",
          "data-active": isActive,
          "data-size": size,
        },
      },
      props,
    ),
    render,
  });
}

export {
  useSidebarVisibility,
  useSidebarToggle,
  SidebarMenuSubButton,
  SidebarMenuSkeleton,
  SidebarGroupContent,
  SidebarMenuSubItem,
  SidebarGroupAction,
  SidebarMenuButton,
  SidebarGroupLabel,
  SidebarSeparator,
  SidebarMenuBadge,
  SidebarProvider,
  SidebarMenuItem,
  SidebarTrigger,
  SidebarMenuSub,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarInset,
  SidebarInput,
  SidebarGroup,
  SidebarRail,
  SidebarMenu,
  useSidebar,
  Sidebar,
};
