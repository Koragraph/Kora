"use client";

import { cn } from "~/util/utils";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

const FADE_BASE = "virtualized-scroll-fade [--fade-size:1.5rem]";
const FADE_MASK_BOTH =
  "[--virtualized-scroll-fade-mask:linear-gradient(to_bottom,transparent,black_var(--fade-size),black_calc(100%-var(--fade-size)),transparent)]";
const FADE_MASK_TOP =
  "[--virtualized-scroll-fade-mask:linear-gradient(to_bottom,transparent,black_var(--fade-size))]";
const FADE_MASK_BOTTOM =
  "[--virtualized-scroll-fade-mask:linear-gradient(to_bottom,black_calc(100%-var(--fade-size)),transparent)]";

function getVirtualizedScrollFadeClassName({ bottom, top }: { bottom: boolean; top: boolean }) {
  if (!top && !bottom) {
    return undefined;
  }
  const mask = top ? (bottom ? FADE_MASK_BOTH : FADE_MASK_TOP) : FADE_MASK_BOTTOM;
  return cn(FADE_BASE, mask);
}

const VIEWPORT_BASE =
  "h-full max-h-[inherit] overflow-auto overscroll-contain rounded-[inherit] outline-none transition-shadows focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-has-overflow-x:overscroll-x-contain";
const VIEWPORT_FADE_MASK =
  "mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))] [--fade-size:1.5rem]";
const HIDDEN_SCROLLBARS =
  "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
const THUMB_CLASS =
  "relative flex-1 rounded-full bg-[var(--app-scrollbar-thumb)] transition-colors hover:bg-[var(--app-scrollbar-thumb-hover)]";
const TRACK_CLASS =
  "flex opacity-0 transition-opacity delay-300 data-[orientation=horizontal]:mx-1 data-[orientation=horizontal]:mb-px data-[orientation=horizontal]:h-1.5 data-[orientation=vertical]:my-1 data-[orientation=vertical]:mr-px data-[orientation=vertical]:w-1.5 data-[orientation=horizontal]:flex-col data-hovering:opacity-100 data-scrolling:opacity-100 data-hovering:delay-0 data-scrolling:delay-0 data-hovering:duration-100 data-scrolling:duration-100";

type ScrollAreaProps = ScrollAreaPrimitive.Root.Props & {
  /** Keep focused and highlighted items clear of the fade. Off for lists
   * whose rows take focus on click, where the scroll would nudge the list. */
  scrollFadePadding?: boolean;
  chainVerticalScroll?: boolean;
  scrollbarGutter?: boolean;
  hideScrollbars?: boolean;
  scrollFade?: boolean;
};

function ScrollArea(allProps: ScrollAreaProps) {
  const {
    className,
    children,
    scrollFade = false,
    hideScrollbars = false,
    scrollbarGutter = false,
    scrollFadePadding = true,
    chainVerticalScroll = false,
    ...rest
  } = allProps;
  const viewportClass = cn(
    VIEWPORT_BASE,
    chainVerticalScroll && "overscroll-y-auto",
    scrollFade && VIEWPORT_FADE_MASK,
    scrollFade && scrollFadePadding && "scroll-p-[var(--fade-size)]",
    hideScrollbars && HIDDEN_SCROLLBARS,
    scrollbarGutter && "scrollbar-gutter-stable",
  );
  const rootClass = cn("relative size-full min-h-0 overflow-hidden rounded-[inherit]", className);

  return (
    <ScrollAreaPrimitive.Root className={rootClass} {...rest}>
      <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className={viewportClass}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      {hideScrollbars ? null : (
        <>
          <ScrollBar orientation="horizontal" />
          <ScrollBar orientation="vertical" />
          <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
        </>
      )}
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar(allProps: ScrollAreaPrimitive.Scrollbar.Props) {
  const { className, orientation = "vertical", ...rest } = allProps;

  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(TRACK_CLASS, className)}
      {...rest}
    >
      <ScrollAreaPrimitive.Thumb data-slot="scroll-area-thumb" className={THUMB_CLASS} />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { getVirtualizedScrollFadeClassName, ScrollArea, ScrollBar };
