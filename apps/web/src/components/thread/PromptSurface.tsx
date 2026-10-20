// The composer is one rounded bar made of four layers; the data attributes below are read by
// PromptBanner and by CSS elsewhere.

import { cn } from "~/util/utils";
import type { ComponentProps } from "react";

const SHELL_CLASS = [
  "@container/composer-surface group/composer-surface relative isolate mx-auto w-full max-w-3xl",
  // tokens shared with the banners that dock above the bar
  "[--chat-composer-drawer-inset:1.375rem]",
  "[--chat-composer-glass-surface:var(--composer-surface)] [--chat-composer-outline:var(--composer-outline)] [--chat-composer-highlight:var(--composer-highlight)]",
  "[--glass-opacity:88%] [--glass-blur:18px] [--glass-saturation:120%]",
  "[--chat-composer-context-extension:2.25rem] sm:[--chat-composer-context-extension:2rem]",
  // the glass layer
  "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-lg",
  // flat: one solid fill, no blur, no gradient
  "before:bg-(--chat-composer-glass-surface)",
  // an attached banner fuses with the bar: the shell's own glass steps aside
  "has-[[data-prompt-banner-surface=attached]]:before:hidden",
].join(" ");

const SHELL_WITH_CONTEXT = [
  "before:bottom-(--chat-composer-context-extension)",
  "supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:bottom-0",
  "supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:[clip-path:inset(0_0_0_0_round_var(--radius-lg)_var(--radius-lg)_0_0)]",
].join(" ");

function Shell(incoming: ComponentProps<"div"> & { contextStrip?: boolean }) {
  const { contextStrip = false, className, ...props } = incoming;
  return (
    <div
      className={cn(SHELL_CLASS, contextStrip && SHELL_WITH_CONTEXT, className)}
      data-slot="composer-shell"
      data-with-context={contextStrip ? true : undefined}
      {...props}
    />
  );
}

function Host({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative z-10 w-full rounded-lg",
        // outline layer
        "after:pointer-events-none after:absolute after:inset-0 after:z-[1] after:rounded-[inherit] after:border after:border-[var(--chat-composer-outline)] dark:after:shadow-[inset_0_1px_0_var(--chat-composer-highlight)]",
        // with a docked banner the main surface owns the outline and glass
        "group-has-[[data-prompt-banner-surface=attached]]/composer-surface:shadow-none group-has-[[data-prompt-banner-surface=attached]]/composer-surface:after:hidden",
        className,
      )}
      data-slot="composer-host"
      {...props}
    />
  );
}

function Main({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "group relative z-10 rounded-lg p-px transition-colors duration-200",
        "after:pointer-events-none after:absolute after:inset-0 after:z-20 after:hidden after:rounded-[inherit] after:border after:border-[var(--chat-composer-outline)] dark:after:shadow-[inset_0_1px_0_var(--chat-composer-highlight)]",
        "group-has-[[data-prompt-banner-surface=attached]]/composer-surface:after:block",
        "group-has-[[data-prompt-banner-surface=attached]]/composer-surface:bg-[color-mix(in_srgb,var(--chat-composer-glass-surface)_var(--glass-opacity),transparent)] group-has-[[data-prompt-banner-surface=attached]]/composer-surface:[backdrop-filter:blur(var(--glass-blur))_saturate(var(--glass-saturation))] group-has-[[data-prompt-banner-surface=attached]]/composer-surface:shadow-[0_12px_28px_-18px_rgb(0_0_0/40%)] dark:group-has-[[data-prompt-banner-surface=attached]]/composer-surface:shadow-none",
        "group-has-[[data-prompt-banner-surface=attached]]/composer-surface:not-supports-[backdrop-filter:blur(1px)]:bg-(--chat-composer-glass-surface)",
        "[&_[data-chat-composer-mobile-collapsed=true]]:min-h-[calc(1rem+1px)]",
        className,
      )}
      data-prompt-main-surface="true"
      {...props}
    />
  );
}

function ContextStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "group/composer-context relative isolate mx-auto -mt-4 flex w-[calc(100%-2*var(--chat-composer-drawer-inset))] items-center gap-2 overflow-x-clip overflow-y-visible ps-1 pe-2 pt-5 pb-1",
        // glass layer behind the strip, masked so its top rem is open
        "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-b-2xl before:border before:border-[var(--chat-composer-outline)] dark:before:border-white/7",
        "before:[mask-image:linear-gradient(to_bottom,transparent_1rem,black_1rem)]",
        "group-has-[[data-prompt-banner-surface=attached]]/composer-surface:before:[background:color-mix(in_srgb,var(--chat-composer-glass-surface)_var(--glass-opacity),transparent)] group-has-[[data-prompt-banner-surface=attached]]/composer-surface:before:[backdrop-filter:blur(var(--glass-blur))_saturate(var(--glass-saturation))]",
        "not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:[background:color-mix(in_srgb,var(--chat-composer-glass-surface)_var(--glass-opacity),transparent)] not-supports-[clip-path:shape(from_0_0,line_to_1px_1px)]:before:[backdrop-filter:blur(var(--glass-blur))_saturate(var(--glass-saturation))]",
        className,
      )}
      data-slot="composer-context-strip"
      {...props}
    />
  );
}

export const PromptSurface = { Shell, Host, Main, ContextStrip };
