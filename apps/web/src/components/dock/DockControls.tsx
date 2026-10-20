import { cn } from "~/util/utils";
import { TooltipTrigger, TooltipPopup, Tooltip } from "~/components/ui/tooltip";
import { DOCK_GROUP_LABELS, DOCK_GROUPS, type DockGroup } from "./rightDock.logic";
import { memo } from "react";
import {
  SquareTerminalIcon,
  FolderTreeIcon,
  WaypointsIcon,
  Globe2Icon,
  type LucideIcon,
} from "lucide-react";

const DOCK_GROUP_ICONS: Record<DockGroup, LucideIcon> = {
  workers: WaypointsIcon,
  files: FolderTreeIcon,
  browser: Globe2Icon,
  terminal: SquareTerminalIcon,
};

export interface DockRailItem {
  readonly group: DockGroup;
  readonly available: boolean;
  /** Shown in the tooltip when the group cannot open here. */
  readonly unavailableReason: string;
  /** Live count on the button (workers working or blocked). */
  readonly badge?: number;
  /** Extra tooltip line, e.g. "3 workers · 1 working". */
  readonly detail?: string;
}

/**
 * Kora's own dock mark: the chat column on the left and three stacked surfaces on the right. When
 * the dock is out, the stack slides left into a solid column, the same motion the dock makes.
 */
function DockGlyph(props: { open: boolean }) {
  return (
    <svg viewBox="0 0 18 14" fill="none" aria-hidden className="h-3.5 w-[18px] shrink-0">
      <path
        d="M1.5 3.5v7M1.5 3.5a2 2 0 0 1 2-2h4M1.5 10.5a2 2 0 0 0 2 2h4"
        strokeLinecap="round"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <g
        className="transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{ transform: props.open ? "translateX(-3px)" : "none" }}
      >
        {props.open ? (
          <rect x="11" y="1.5" width="5.5" height="11" rx="1.6" fill="currentColor" />
        ) : (
          <>
            <rect x="11" y="1.5" width="5.5" height="2.6" rx="1.3" fill="currentColor" />
            <rect
              x="11"
              y="5.7"
              width="5.5"
              height="2.6"
              rx="1.3"
              fill="currentColor"
              opacity="0.6"
            />
            <rect
              x="11"
              y="9.9"
              width="5.5"
              height="2.6"
              rx="1.3"
              fill="currentColor"
              opacity="0.35"
            />
          </>
        )}
      </g>
    </svg>
  );
}

/**
 * The one way into the dock: a labelled control at the top bar's right end. It reopens the dock
 * where it was left (or on Workers/Files the first time); switching between groups happens on the
 * dock's own tabs. Open is marked by a bar under the label (the dock's tab language), never a
 * filled chip. A live count of working workers rides beside the label while the dock is in.
 */
export const DockToggleButton = memo(function DockToggleButton(props: {
  open: boolean;
  badge: number;
  onToggle: () => void;
}) {
  const label = props.open ? "Tuck the dock away" : "Pull out the dock";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-dock-toggle
            aria-label={props.badge > 0 ? `${label}, ${props.badge} working` : label}
            aria-pressed={props.open}
            onClick={props.onToggle}
            className={cn(
              "group/dock-toggle relative flex h-7 shrink-0 cursor-pointer items-center gap-1.5 px-1.5 text-xs font-medium transition-colors focus-visible:outline-none [-webkit-app-region:no-drag]",
              props.open ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          />
        }
      >
        <DockGlyph open={props.open} />
        <span>Dock</span>
        {props.badge > 0 && !props.open ? (
          <span aria-hidden className="text-[10px] font-semibold tabular-nums text-foreground">
            {props.badge}
          </span>
        ) : null}
        <span
          aria-hidden
          className={cn(
            "absolute inset-x-1.5 bottom-0 h-0.5 rounded-full transition-colors",
            props.open
              ? "bg-foreground"
              : "bg-transparent group-hover/dock-toggle:bg-foreground/20 group-focus-visible/dock-toggle:bg-ring",
          )}
        />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});

/**
 * The side panel's group switcher: Workers · Files · Browser · Terminal as one segmented control
 * in the panel header. Labels drop to icons when the panel is narrow.
 */
export const DockGroupTabs = memo(function DockGroupTabs(props: {
  items: readonly DockRailItem[];
  activeGroup: DockGroup | null;
  onSelect: (group: DockGroup) => void;
}) {
  const byGroup = new Map(props.items.map((item) => [item.group, item] as const));
  return (
    <div
      role="tablist"
      aria-label="Side panel"
      data-dock-tabs
      className="flex min-w-0 items-center gap-0.5 rounded-[var(--control-radius)] bg-muted/60 p-0.5 [-webkit-app-region:no-drag]"
    >
      {DOCK_GROUPS.map((group) => {
        const item = byGroup.get(group);
        if (!item) return null;
        return (
          <DockGroupTab
            key={group}
            item={item}
            active={props.activeGroup === group}
            onSelect={props.onSelect}
          />
        );
      })}
    </div>
  );
});

function DockGroupTab(props: {
  item: DockRailItem;
  active: boolean;
  onSelect: (group: DockGroup) => void;
}) {
  const { item, active } = props;
  const Icon = DOCK_GROUP_ICONS[item.group];
  const label = DOCK_GROUP_LABELS[item.group];
  const badge = item.badge ?? 0;
  const tooltip = !item.available
    ? `${label} · ${item.unavailableReason}`
    : item.detail
      ? `${label} · ${item.detail}`
      : label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            role="tab"
            aria-label={badge > 0 ? `${label}, ${badge} working` : label}
            aria-selected={active}
            aria-disabled={!item.available || undefined}
            data-dock-group={item.group}
            data-active={active ? "true" : undefined}
            onClick={() => {
              if (item.available && !active) props.onSelect(item.group);
            }}
            className={cn(
              "relative flex h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded-[calc(var(--control-radius)-2px)] px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
              !item.available && "cursor-default opacity-40 hover:text-muted-foreground",
            )}
          />
        }
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="hidden truncate @[26rem]/dock:inline">{label}</span>
        {badge > 0 ? (
          <span
            aria-hidden
            className="flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-full bg-foreground px-1 text-[9px] font-semibold tabular-nums text-background"
          >
            {badge}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
