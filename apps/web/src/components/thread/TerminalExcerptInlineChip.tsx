import { cn } from "~/util/utils";
import { mark, pill } from "../tagStyles";
import type { ContextDisplayCapability } from "../contextDisplayRegistry";
import { ContextTagPopover, ContextTagShell } from "../contextTagParts";
import { TerminalIcon } from "lucide-react";

export function TerminalExcerptInlineChip({
  label,
  terminalLabel,
  lineStart,
  lineEnd,
  text,
  detailsMode,
  expired = false,
  surface = "composer",
}: {
  detailsMode: ContextDisplayCapability["details"];
  surface?: "composer" | "transcript";
  terminalLabel: string;
  lineStart: number;
  expired?: boolean;
  lineEnd: number;
  label: string;
  text: string;
}) {
  const transcript = surface === "transcript";
  const chipClass = transcript ? cn(mark.base, mark.tint) : cn(pill.base, pill.tint);
  const interactiveClass = transcript ? mark.hover : pill.hover;
  const labelClass = transcript ? mark.label : pill.label;

  const icon = (
    <TerminalIcon className={cn(pill.icon, "text-current", "size-3.5", expired && "opacity-100")} />
  );

  if (!expired && text.length > 0 && detailsMode === "popover") {
    const lines = lineStart === lineEnd ? `Line ${lineStart}` : `Lines ${lineStart}–${lineEnd}`;
    return (
      <ContextTagPopover
        accessibleLabel={`Terminal excerpt, ${label}`}
        chip={
          <span className={chipClass}>
            {icon}
            <span className={labelClass}>{label}</span>
          </span>
        }
        popupClassName="w-[min(40rem,calc(100vw-2rem))]"
        triggerClassName={cn(chipClass, interactiveClass, "cursor-pointer")}
        viewportClassName="overflow-hidden p-2"
      >
        <div className="rounded-md border border-border/70 bg-background/80">
          <div className="flex items-center gap-2 border-border/70 border-b px-3 py-2">
            <TerminalIcon className="size-4 shrink-0 text-emerald-500" />
            <span className="truncate font-medium text-foreground text-sm">{terminalLabel}</span>
            <span className="ml-auto text-secondary-label text-xs">{lines}</span>
          </div>
          <pre
            aria-label="Captured terminal output"
            className="max-h-80 overflow-auto whitespace-pre bg-muted p-3 font-mono text-xs leading-relaxed [tab-size:4] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            tabIndex={0}
          >
            {text}
          </pre>
        </div>
      </ContextTagPopover>
    );
  }

  const tooltip = expired
    ? `Terminal context expired. Remove and re-add ${label} to include it in your message.`
    : detailsMode === "none"
      ? undefined
      : text;

  return (
    <ContextTagShell
      aria-label={`Terminal excerpt, ${label}${expired ? ", expired" : ""}`}
      className={cn(
        chipClass,
        expired && "border-destructive/35 bg-destructive/8 text-destructive",
      )}
      data-terminal-context-expired={expired ? "true" : undefined}
      icon={icon}
      label={label}
      labelClassName={labelClass}
      tooltip={tooltip}
      tooltipClassName="max-w-80 whitespace-pre-wrap leading-tight"
    />
  );
}
