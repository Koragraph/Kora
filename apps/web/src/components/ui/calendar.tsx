"use client";

import { DayPicker, type ChevronProps } from "@daypicker/react";
import { ChevronLeftIcon, ChevronRightIcon, ChevronsUpDownIcon } from "lucide-react";
import type { ComponentProps, ReactElement } from "react";

import { cn } from "~/util/utils";

type CalendarProps = ComponentProps<typeof DayPicker>;

function CalendarChevron({ orientation, className }: ChevronProps) {
  if (orientation === "left") {
    return <ChevronLeftIcon aria-hidden="true" className={cn("rtl:rotate-180", className)} />;
  }
  if (orientation === "right") {
    return <ChevronRightIcon aria-hidden="true" className={cn("rtl:rotate-180", className)} />;
  }
  return <ChevronsUpDownIcon aria-hidden="true" className={className} />;
}

const navButton =
  "inline-flex size-(--cell-size) items-center justify-center rounded-lg text-base text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-64 sm:text-sm [&_svg]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4";

const DEFAULT_CLASSES: Record<string, string> = {
  root: "w-fit [--cell-size:--spacing(10)] sm:[--cell-size:--spacing(9)]",
  months: "relative flex flex-col gap-2 sm:flex-row",
  month: "w-full",
  month_caption:
    "relative z-[2] mx-(--cell-size) mb-1 flex h-(--cell-size) items-center justify-center px-1",
  caption_label: "flex h-full items-center gap-2 font-medium text-base sm:text-sm",
  nav: "absolute top-0 z-[1] flex w-full items-center justify-between",
  button_previous: navButton,
  button_next: navButton,
  dropdowns:
    "flex h-(--cell-size) w-full items-center justify-center gap-1.5 text-base sm:text-sm [&>span]:font-medium",
  dropdown_root:
    "relative h-9 rounded-lg border border-input px-[calc(--spacing(3)-1px)] shadow-xs/5 has-focus-visible:border-ring has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50 sm:h-8 [&_svg]:-me-1 [&_svg]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
  dropdown: "absolute inset-0 bg-popover opacity-0",
  weekday: "size-(--cell-size) p-0 font-medium text-muted-foreground/72 text-xs",
  week_number: "size-(--cell-size) p-0 font-medium text-muted-foreground/72 text-xs",
  day: "size-(--cell-size) py-px text-sm",
  day_button:
    "relative inline-flex size-(--cell-size) cursor-pointer items-center justify-center whitespace-nowrap rounded-lg border border-transparent font-medium text-base outline-none transition-[border-radius,box-shadow] focus-visible:z-[1] focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:text-sm [[data-disabled=true]_&]:pointer-events-none [[data-disabled=true]_&]:text-muted-foreground/72 [[data-disabled=true]_&]:line-through [[data-outside=true]_&]:text-muted-foreground/72 [[data-selected=true]_&]:bg-primary [[data-selected=true]_&]:text-primary-foreground [[data-selected=true][data-outside=true]_&]:text-primary-foreground [.range-middle[data-selected=true]_&]:bg-accent [.range-middle[data-selected=true]_&]:text-foreground [.range-middle_&]:rounded-none [.range-end:not(.range-start)_&]:rounded-s-none [.range-start:not(.range-end)_&]:rounded-e-none [td:not([data-selected])>&]:hover:bg-accent",
  outside: "text-muted-foreground data-selected:bg-accent/50 data-selected:text-muted-foreground",
  today:
    "[&_button]:after:pointer-events-none [&_button]:after:absolute [&_button]:after:bottom-1 [&_button]:after:start-1/2 [&_button]:after:size-[3px] [&_button]:after:-translate-x-1/2 [&_button]:after:rounded-full [&_button]:after:bg-primary data-selected:[&_button]:after:bg-background [.range-middle[data-selected=true]_button]:after:bg-primary [[data-disabled=true]_button]:after:bg-foreground/30",
  hidden: "invisible",
  range_start: "range-start",
  range_middle: "range-middle",
  range_end: "range-end",
};

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  components,
  ...props
}: CalendarProps): ReactElement {
  const merged: Record<string, string> = {};
  for (const [key, base] of Object.entries(DEFAULT_CLASSES)) {
    merged[key] = cn(base, (classNames as Record<string, string | undefined> | undefined)?.[key]);
  }
  for (const [key, extra] of Object.entries(classNames ?? {})) {
    if (!(key in merged) && typeof extra === "string") merged[key] = extra;
  }

  return (
    <DayPicker
      className={cn(className)}
      classNames={merged}
      components={{ Chevron: CalendarChevron, ...components }}
      data-slot="calendar"
      formatters={{
        formatMonthDropdown: (date) => date.toLocaleString("default", { month: "short" }),
        ...props.formatters,
      }}
      mode="single"
      showOutsideDays={showOutsideDays}
      {...props}
    />
  );
}

export { Calendar };
