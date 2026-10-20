import { cn } from "~/util/utils";
import { ScrollArea } from "../ui/scroll-area";
import { buttonVariants, Button } from "../ui/button";
import type { ComponentProps } from "react";
import { ChevronDownIcon, XIcon } from "lucide-react";
import { useRender } from "@base-ui/react/use-render";
import { mergeProps } from "@base-ui/react/merge-props";

export type PromptBannerVariant = "default" | "error" | "info" | "success" | "warning";
type Placement = "attached" | "floating";

// Colour tokens of the glass layer, per variant. Neutral variants only differ by name.
const VARIANT_VARS: Record<PromptBannerVariant, string> = {
  default: "",
  info: "",
  success: "",
  error:
    "[--chat-composer-attached-outline:color-mix(in_srgb,var(--error)_32%,transparent)] [--chat-composer-attached-tint:color-mix(in_srgb,var(--error)_8%,transparent)]",
  warning:
    "[--chat-composer-attached-outline:color-mix(in_srgb,var(--warning)_28%,transparent)] [--chat-composer-attached-tint:color-mix(in_srgb,var(--warning)_8%,transparent)]",
};

const SURFACE_BASE = [
  "relative isolate",
  // default colour tokens (each can be overridden through the --chat-composer-* variables)
  "[--chat-composer-attached-surface:var(--chat-composer-glass-surface,var(--card))] dark:[--chat-composer-attached-surface:var(--chat-composer-glass-surface,var(--surface-raised))]",
  "[--chat-composer-attached-outline:var(--chat-composer-outline,color-mix(in_srgb,var(--contrast-foreground)_8%,transparent))] dark:[--chat-composer-attached-outline:var(--chat-composer-outline,color-mix(in_srgb,var(--ink-white)_5%,transparent))]",
  "[--chat-composer-attached-tint:transparent]",
  // the glass is a pseudo layer behind the content
  "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:border before:border-[var(--chat-composer-attached-outline)]",
  "before:[background:linear-gradient(var(--chat-composer-attached-tint),var(--chat-composer-attached-tint)),color-mix(in_srgb,var(--chat-composer-attached-surface)_calc(var(--glass-opacity,1)*100%),transparent)]",
  "before:[backdrop-filter:blur(var(--glass-blur,0px))_saturate(var(--glass-saturation,1))]",
  "before:shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] dark:before:shadow-[0_14px_32px_-18px_rgb(0_0_0/75%)]",
  "not-supports-[backdrop-filter:blur(1px)]:before:bg-[var(--chat-composer-attached-surface)]",
].join(" ");

const SURFACE_PLACEMENT: Record<Placement, string> = {
  attached: [
    "[--chat-composer-attachment-overlap:calc(1rem+1px)] before:rounded-t-lg",
    // transparent over the overlap band; the 1px bleed keeps Chromium from dropping the last backdrop row
    "before:[mask-image:linear-gradient(to_top,transparent_calc(var(--chat-composer-attachment-overlap)-1px),black_calc(var(--chat-composer-attachment-overlap)-1px))]",
    "dark:supports-[backdrop-filter:blur(1px)]:before:[background:linear-gradient(var(--chat-composer-attached-tint),var(--chat-composer-attached-tint)),linear-gradient(to_top,transparent_var(--chat-composer-attachment-overlap),rgb(0_0_0/18%)_var(--chat-composer-attachment-overlap),transparent_calc(var(--chat-composer-attachment-overlap)+10px)),color-mix(in_srgb,var(--chat-composer-attached-surface)_calc(var(--glass-opacity,1)*100%),transparent)]",
  ].join(" "),
  floating: "[--chat-composer-attachment-overlap:0px] before:rounded-lg",
};

function Surface(
  incoming: ComponentProps<"div"> & { placement?: Placement; variant?: PromptBannerVariant },
) {
  const { placement = "attached", variant = "default", className, ...props } = incoming;
  return (
    <div
      className={cn(SURFACE_BASE, SURFACE_PLACEMENT[placement], VARIANT_VARS[variant], className)}
      data-prompt-banner-surface={placement}
      data-variant={variant}
      {...props}
    />
  );
}

const PEEK_BORDER: Record<PromptBannerVariant, string> = {
  default: "border-[var(--chat-composer-outline,var(--border))]",
  info: "border-[var(--chat-composer-outline,var(--border))]",
  success: "border-[var(--chat-composer-outline,var(--border))]",
  error: "border-destructive/24",
  warning: "border-warning/24",
};

function Peek(incoming2: ComponentProps<"button"> & { variant?: PromptBannerVariant }) {
  const { variant = "default", className, ...props } = incoming2;
  return (
    <button
      className={cn(
        "absolute inset-x-0 bottom-0 z-0 mx-auto h-3 w-[96%] cursor-pointer rounded-t-lg border border-b-0 bg-[var(--chat-composer-glass-surface,var(--card))] shadow-[0_6px_18px_rgb(0_0_0/6%)] transition-opacity duration-150 ease-out focus-visible:outline-2 focus-visible:outline-ring dark:bg-[var(--chat-composer-glass-surface,var(--surface-raised))]",
        PEEK_BORDER[variant],
        className,
      )}
      data-slot="composer-banner-peek"
      type="button"
      {...props}
    />
  );
}

function Attachment({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mx-auto mb-[calc(-1rem-1px)] w-[calc(100%-2*var(--chat-composer-drawer-inset,0px))]",
        // stacked attachments share one outline
        "[&+&_[data-prompt-banner-surface]]:before:rounded-t-none [&+&_[data-prompt-banner-surface]]:before:border-t-0",
        className,
      )}
      data-slot="composer-banner-attachment"
      {...props}
    />
  );
}

function Dock({ className, ...props }: ComponentProps<"div">) {
  return (
    <Attachment
      className={cn(
        "flex items-end gap-1 not-has-[[data-prompt-banner-surface=attached]]:hidden",
        className,
      )}
      {...props}
    />
  );
}

function Column({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col empty:hidden *:data-[slot=composer-banner-attachment]:w-full [&>:last-child]:mb-0",
        className,
      )}
      {...props}
    />
  );
}

function Root({
  placement = "attached",
  variant = "default",
  density = "default",
  width = "fill",
  className,
  ...props
}: ComponentProps<"div"> & {
  density?: "default" | "comfortable";
  placement?: Placement;
  variant?: PromptBannerVariant;
  width?: "fill" | "content";
}) {
  return (
    <Surface
      className={cn(
        "min-w-0 px-1 text-xs/4 [--composer-banner-icon-column:--spacing(7)] sm:[--composer-banner-icon-column:--spacing(6)]",
        density === "comfortable"
          ? "[--composer-banner-padding-block:--spacing(1.25)]"
          : "[--composer-banner-padding-block:--spacing(1)]",
        "pt-(--composer-banner-padding-block) pb-[calc(var(--chat-composer-attachment-overlap)+var(--composer-banner-padding-block))]",
        width === "content" ? "w-fit max-w-full flex-none" : "@container",
        className,
      )}
      data-prompt-banner-width={width}
      data-slot="composer-banner"
      placement={placement}
      variant={variant}
      {...props}
    />
  );
}

function Row(
  incoming3: useRender.ComponentProps<"div"> & {
    layout?: "inline" | "wrap-actions" | "wrap-actions-narrow";
  },
) {
  const { layout = "inline", className, render, ...props } = incoming3;
  const merged = mergeProps<"div">(
    {
      ...{ "data-prompt-banner-layout": layout, "data-prompt-banner-row": "true" },
      className: cn(
        "grid min-h-(--composer-banner-icon-column) grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)_auto] items-center gap-x-1 text-start",
        "not-has-[[data-slot=composer-banner-actions]]:grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)]",
        "[button&]:cursor-pointer [button&]:rounded-lg [button&]:focus-visible:outline-2 [button&]:focus-visible:-outline-offset-2 [button&]:focus-visible:outline-ring",
        layout === "wrap-actions" &&
          "@max-[400px]:[&:has([data-slot=composer-banner-actions]>:nth-child(2))_[data-slot=composer-banner-actions]]:col-span-2 @max-[400px]:[&:has([data-slot=composer-banner-actions]>:nth-child(2))_[data-slot=composer-banner-actions]]:col-start-2 @max-[400px]:[&:has([data-slot=composer-banner-actions]>:nth-child(2))_[data-slot=composer-banner-actions]]:row-start-2 @max-[400px]:[&:has([data-slot=composer-banner-actions]>:nth-child(2))_[data-slot=composer-banner-actions]]:ms-[-8px] @max-[400px]:[&:has([data-slot=composer-banner-actions]>:nth-child(2))_[data-slot=composer-banner-actions]]:justify-start",
        layout === "wrap-actions-narrow" &&
          "@max-[320px]:[&:has([data-slot=composer-banner-actions]>:nth-child(2))_[data-slot=composer-banner-actions]]:col-span-2 @max-[320px]:[&:has([data-slot=composer-banner-actions]>:nth-child(2))_[data-slot=composer-banner-actions]]:col-start-2 @max-[320px]:[&:has([data-slot=composer-banner-actions]>:nth-child(2))_[data-slot=composer-banner-actions]]:row-start-2 @max-[320px]:[&:has([data-slot=composer-banner-actions]>:nth-child(2))_[data-slot=composer-banner-actions]]:ms-[-8px] @max-[320px]:[&:has([data-slot=composer-banner-actions]>:nth-child(2))_[data-slot=composer-banner-actions]]:justify-start",
        className,
      ),
    },
    props,
  );
  return useRender({ render, props: merged, defaultTagName: "div" });
}

function Icon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "col-start-1 row-start-1 flex w-(--composer-banner-icon-column) items-center justify-center text-muted-foreground [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      data-slot="composer-banner-icon"
      {...props}
    />
  );
}

function Content({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "col-start-2 row-start-1 flex items-center gap-1 *:data-[slot=composer-banner-separator]:m-0",
        // without an icon the content takes the icon column too
        "[[data-prompt-banner-row]:not(:has([data-slot=composer-banner-icon]))_&]:col-span-2 [[data-prompt-banner-row]:not(:has([data-slot=composer-banner-icon]))_&]:col-start-1 [[data-prompt-banner-row]:not(:has([data-slot=composer-banner-icon]))_&]:ps-2 sm:[[data-prompt-banner-row]:not(:has([data-slot=composer-banner-icon]))_&]:ps-1.5",
        "[[data-prompt-banner-row]:not(:has([data-slot=composer-banner-icon])):not(:has([data-slot=composer-banner-actions]))_&]:pe-2 sm:[[data-prompt-banner-row]:not(:has([data-slot=composer-banner-icon])):not(:has([data-slot=composer-banner-actions]))_&]:pe-1.5",
        className,
      )}
      data-slot="composer-banner-content"
      {...props}
    />
  );
}

function Separator() {
  return (
    <span
      aria-hidden="true"
      className="mx-1 text-muted-foreground/40"
      data-slot="composer-banner-separator"
    >
      ·
    </span>
  );
}

function Actions({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "col-start-3 row-start-1 flex flex-wrap items-center justify-end gap-1",
        className,
      )}
      data-slot="composer-banner-actions"
      {...props}
    />
  );
}

function Children(incoming4: useRender.ComponentProps<"div">) {
  const { className, render, ...props } = incoming4;
  const gridDefaults = {
    className: cn("grid gap-px [&_[data-prompt-banner-row]]:min-h-5", className),
  };
  return useRender({
    render,
    props: mergeProps<"div">(gridDefaults, props),
    defaultTagName: "div",
  });
}

function Scroll({ className, ...props }: ComponentProps<typeof ScrollArea>) {
  return (
    <ScrollArea
      className={cn(
        "h-auto max-h-[min(24rem,40dvh)] rounded-none [&_[data-slot=scroll-area-viewport][data-has-overflow-y]]:pe-2",
        className,
      )}
      scrollFade
      {...props}
    />
  );
}

function Count({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex min-w-(--composer-banner-icon-column) items-center justify-center font-medium text-muted-foreground tabular-nums",
        className,
      )}
      {...props}
    />
  );
}

function Body({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "min-w-0 ps-[calc(var(--composer-banner-icon-column)+--spacing(1))]",
        className,
      )}
      {...props}
    />
  );
}

function Dot({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("size-1.5 rounded-full bg-current", className)} {...props} />;
}

function ToggleIcon({ expanded, className }: { expanded: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        buttonVariants({ size: "icon-xs", variant: "ghost" }),
        "pointer-events-none",
        className,
      )}
    >
      <ChevronDownIcon className={cn("size-3.5", !expanded && "rotate-180")} />
    </span>
  );
}

function Dismiss({ children, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button size="icon-xs" variant="ghost" {...props}>
      {children ?? <XIcon className="size-3.5" />}
    </Button>
  );
}

export const PromptBanner = {
  Surface,
  Peek,
  Attachment,
  Dock,
  Column,
  Root,
  Row,
  Icon,
  Content,
  Separator,
  Actions,
  Children,
  Scroll,
  Count,
  Body,
  Dot,
  ToggleIcon,
  Dismiss,
};
