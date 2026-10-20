import { cn } from "~/util/utils";
import { Separator } from "../ui/separator";
import { SelectTrigger } from "../ui/select";
import { Button } from "../ui/button";
import type { ComponentProps } from "react";
import { ChevronDownIcon, type LucideIcon } from "lucide-react";

export type PromptControlSize = "sm" | "xs";

type PromptControlProps = Omit<ComponentProps<typeof Button>, "size"> & {
  size?: PromptControlSize;
};

type PromptSelectControlProps = Omit<ComponentProps<typeof SelectTrigger>, "size"> & {
  size?: PromptControlSize;
};

const promptControlClassName =
  "rounded-[var(--control-radius)] text-secondary-label transition-none hover:text-foreground [&_svg[data-prompt-control-chevron]]:-mx-0.5 [&_svg[data-prompt-control-icon]]:mx-0";
const expandedPromptControlClassName = "h-7 min-h-7 gap-1.5 px-2.5";
const restingPromptControlClassName =
  "[--control-icon-color:currentColor] font-normal text-muted-foreground/70 hover:text-foreground/80 [&_svg[data-prompt-control-chevron]]:-me-1 [&_svg[data-prompt-control-chevron]]:ms-0";

export function PromptControl({
  className,
  size = "sm",
  variant = "ghost",
  ...props
}: PromptControlProps) {
  return (
    <Button
      className={cn(
        promptControlClassName,
        size === "xs" ? restingPromptControlClassName : expandedPromptControlClassName,
        className,
      )}
      size={size}
      variant={variant}
      {...props}
    />
  );
}

export function PromptControlIcon({
  icon: Icon,
  className,
  opticalSize = "default",
  size = "sm",
}: {
  icon: LucideIcon;
  className?: string | undefined;
  opticalSize?: "default" | "large";
  size?: PromptControlSize;
}) {
  return (
    <Icon
      className={cn(
        "shrink-0",
        size === "xs" ? "size-3" : opticalSize === "large" ? "size-4.5" : "size-4",
        className,
      )}
      data-prompt-control-icon
      aria-hidden="true"
    />
  );
}

export function PromptControlChevron({
  className,
  size = "sm",
}: {
  className?: string;
  size?: PromptControlSize;
} = {}) {
  return (
    <ChevronDownIcon
      className={cn(
        "shrink-0",
        size === "xs" ? "size-3 text-current opacity-50" : "size-3.5 text-icon-muted",
        className,
      )}
      data-prompt-control-chevron
      strokeWidth={2.25}
      aria-hidden="true"
    />
  );
}

function PromptControlSeparator({
  className,
  size = "sm",
  ...props
}: Omit<ComponentProps<typeof Separator>, "orientation"> & {
  size?: PromptControlSize;
}) {
  return (
    <Separator
      orientation="vertical"
      className={cn("mx-0.5 hidden sm:block", size === "xs" ? "h-3.5!" : "h-4", className)}
      {...props}
    />
  );
}

function PromptSelectControl({
  className,
  size = "sm",
  variant = "ghost",
  ...props
}: PromptSelectControlProps) {
  return (
    <SelectTrigger
      className={cn(
        promptControlClassName,
        size === "xs" ? restingPromptControlClassName : expandedPromptControlClassName,
        className,
      )}
      icon={<PromptControlChevron size={size} />}
      size={size}
      variant={variant}
      {...props}
    />
  );
}
