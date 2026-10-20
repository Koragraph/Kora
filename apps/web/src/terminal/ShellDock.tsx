import type { HostThreadRef, ThreadId } from "@kora/contracts";
import { ptyLabelFor } from "@kora/shared/ptyLabels";
import { Columns2Icon, PlusIcon, Rows2Icon, TerminalIcon, XIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../appearance/appearanceFonts";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { MAX_TERMINALS_PER_GROUP, type ThreadTerminalGroup } from "../types";
import { confirmTerminalClose } from "../util/terminalCloseConfirm";
import type { TerminalExcerptSelection } from "../util/terminalContext";
import { cn } from "../util/utils";
import { TerminalViewport } from "./TerminalViewport";

interface LaunchLocation {
  readonly cwd: string;
  readonly worktreePath?: string | null;
  readonly runtimeEnv?: Record<string, string>;
}

export interface ShellDockProps {
  threadRef: HostThreadRef;
  threadId: ThreadId;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  terminalIds: string[];
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalId: string;
  activeTerminalGroupId: string;
  terminalLabelsById?: ReadonlyMap<string, string>;
  terminalLaunchLocationsById?: ReadonlyMap<string, LaunchLocation>;
  focusRequestId: number;
  visible?: boolean;
  onActiveTerminalChange: (terminalId: string) => void;
  onNewTerminal: () => void;
  onSplitTerminal: () => void;
  onSplitTerminalVertical: () => void;
  onCloseTerminal: (terminalId: string) => void;
  onAddTerminalContext: (selection: TerminalExcerptSelection) => void;
}

/** Trimmed, de-duplicated, order kept. */
function cleanIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

/**
 * Every live shell sits in exactly one split group: unknown or repeated ids are dropped, group ids are made unique,
 * loose shells get a group of their own, and groups follow the order their first shell was opened in.
 */
export function arrangeShellGroups(
  groups: readonly ThreadTerminalGroup[],
  shellIds: readonly string[],
): ThreadTerminalGroup[] {
  const order = new Map(shellIds.map((id, index) => [id, index]));
  const placed = new Set<string>();
  const taken = new Set<string>();
  const uniqueId = (wanted: string) => {
    let candidate = wanted;
    for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${wanted}-${suffix}`;
    taken.add(candidate);
    return candidate;
  };

  const arranged: ThreadTerminalGroup[] = [];
  for (const group of groups) {
    const members = cleanIds(group.terminalIds).filter((id) => order.has(id) && !placed.has(id));
    if (members.length === 0) continue;
    for (const id of members) placed.add(id);
    arranged.push({
      id: uniqueId(group.id.trim() || `group-${members[0]}`),
      terminalIds: members,
      ...(group.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
    });
  }
  for (const id of shellIds) {
    if (!placed.has(id)) arranged.push({ id: uniqueId(`group-${id}`), terminalIds: [id] });
  }
  const firstOpened = (group: ThreadTerminalGroup) =>
    Math.min(...group.terminalIds.map((id) => order.get(id)!));
  return arranged.sort((a, b) => firstOpened(a) - firstOpened(b));
}

function IconAction(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            aria-disabled={props.disabled || undefined}
            onClick={props.disabled ? undefined : props.onClick}
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground [&_svg]:size-3.5",
              props.disabled
                ? "cursor-not-allowed opacity-40"
                : "cursor-pointer hover:bg-foreground/8 hover:text-foreground",
            )}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom" sideOffset={6} className="pointer-events-none select-none">
        {props.label}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Tracks the dock's height and bumps an epoch on window resizes / re-shows, so terminals refit. */
function useDockMetrics(visible: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(0);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => setHeight(node.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const bump = () => setEpoch((n) => n + 1);
    window.addEventListener("resize", bump);
    return () => window.removeEventListener("resize", bump);
  }, []);
  useEffect(() => {
    if (visible) setEpoch((n) => n + 1);
  }, [visible]);
  return { ref, height, epoch };
}

function ShellDockImpl(props: ShellDockProps) {
  const {
    threadRef,
    threadId,
    focusRequestId,
    onActiveTerminalChange,
    onCloseTerminal,
    visible = true,
  } = props;
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const metrics = useDockMetrics(visible);

  const shellIds = useMemo(() => cleanIds(props.terminalIds), [props.terminalIds]);
  const groups = useMemo(
    () => arrangeShellGroups(props.terminalGroups, shellIds),
    [props.terminalGroups, shellIds],
  );
  const requested = props.activeTerminalId.trim();
  const activeId = shellIds.includes(requested) ? requested : (shellIds[0] ?? "");
  const activeGroup =
    groups.find((g) => g.id === props.activeTerminalGroupId) ??
    groups.find((g) => g.terminalIds.includes(activeId)) ??
    groups[0];
  const shown = activeGroup?.terminalIds ?? (activeId ? [activeId] : []);
  const stacked = activeGroup?.splitDirection === "vertical";
  const full = shown.length >= MAX_TERMINALS_PER_GROUP;

  const labelOf = useCallback(
    (id: string) => props.terminalLabelsById?.get(id) ?? ptyLabelFor(id),
    [props.terminalLabelsById],
  );
  const close = (id: string) => {
    void confirmTerminalClose([labelOf(id)]).then((ok) => ok && onCloseTerminal(id));
  };

  if (shellIds.length === 0) {
    return (
      <section
        ref={metrics.ref}
        data-terminal-dock=""
        data-terminal-owner="right-panel"
        className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-background px-4 text-center text-sm text-muted-foreground"
      >
        <TerminalIcon className="size-5 opacity-60" aria-hidden />
        <p>No shells in this chat yet.</p>
        <Button size="xs" variant="outline" onClick={props.onNewTerminal}>
          Open a shell
        </Button>
      </section>
    );
  }

  const viewport = (id: string) => {
    const at = props.terminalLaunchLocationsById?.get(id);
    const worktreePath = at ? at.worktreePath : props.worktreePath;
    const runtimeEnv = at ? at.runtimeEnv : props.runtimeEnv;
    return (
      <TerminalViewport
        key={id}
        threadRef={threadRef}
        threadId={threadId}
        terminalId={id}
        terminalLabel={labelOf(id) || "Terminal"}
        cwd={at?.cwd ?? props.cwd}
        {...(worktreePath !== undefined ? { worktreePath } : {})}
        {...(runtimeEnv ? { runtimeEnv } : {})}
        advancedTypography={advancedTypography}
        visible={visible}
        autoFocus={id === activeId}
        focusRequestId={focusRequestId}
        drawerHeight={metrics.height}
        resizeEpoch={metrics.epoch}
        onSessionExited={() => onCloseTerminal(id)}
        onAddTerminalContext={props.onAddTerminalContext}
      />
    );
  };

  return (
    <section
      ref={metrics.ref}
      data-terminal-dock=""
      data-terminal-owner="right-panel"
      className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-[var(--terminal-background)]"
    >
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-1.5">
        <nav aria-label="Shells" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {groups.map((group) => (
            <div
              key={group.id}
              className={cn(
                "flex shrink-0 items-center rounded-md",
                group.terminalIds.length > 1 && "bg-foreground/4",
              )}
            >
              {group.terminalIds.map((id) => {
                const selected = id === activeId;
                return (
                  <div
                    key={id}
                    className={cn(
                      "group/shell flex h-6 max-w-40 items-center gap-1 rounded-md pr-0.5 pl-2 text-xs",
                      selected
                        ? "bg-foreground/10 text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <button
                      type="button"
                      aria-current={selected || undefined}
                      onClick={() => onActiveTerminalChange(id)}
                      className="min-w-0 cursor-pointer truncate"
                    >
                      {labelOf(id)}
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${labelOf(id)}`}
                      onClick={() => close(id)}
                      className={cn(
                        "inline-flex size-4 cursor-pointer items-center justify-center rounded hover:bg-foreground/10",
                        selected
                          ? "opacity-70"
                          : "opacity-0 group-hover/shell:opacity-70 focus-visible:opacity-70",
                      )}
                    >
                      <XIcon className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
          <IconAction label="Open a shell" onClick={props.onNewTerminal}>
            <PlusIcon />
          </IconAction>
        </nav>
        <IconAction
          label={full ? `Split (at most ${MAX_TERMINALS_PER_GROUP} shells)` : "Split right"}
          disabled={full}
          onClick={props.onSplitTerminal}
        >
          <Columns2Icon />
        </IconAction>
        <IconAction
          label={full ? `Split (at most ${MAX_TERMINALS_PER_GROUP} shells)` : "Split down"}
          disabled={full}
          onClick={props.onSplitTerminalVertical}
        >
          <Rows2Icon />
        </IconAction>
      </header>
      <div
        className="grid min-h-0 flex-1"
        style={
          stacked
            ? { gridTemplateRows: `repeat(${shown.length}, minmax(0, 1fr))` }
            : { gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }
        }
      >
        {shown.map((id, index) => (
          <div
            key={id}
            className={cn(
              "min-h-0 min-w-0",
              index > 0 && (stacked ? "border-t" : "border-l"),
              "border-border/60",
            )}
            onMouseDown={() => id !== activeId && onActiveTerminalChange(id)}
          >
            {viewport(id)}
          </div>
        ))}
      </div>
    </section>
  );
}

const ShellDock = memo(ShellDockImpl);
export default ShellDock;
