/**
 * The Side grid of worker boxes (docs/fleet/WORKER-BOXES.md): up to four boxes in a 2×2 where the terminal panes
 * used to be, the rest (and anything minimized) as one-line strips stacked under it, and ⤢ to fill the dock with
 * one box (Esc or ⤢ again returns). Layout rules live in workerBoxes.logic.ts.
 */
import type { FleetWorker, HostThreadRef } from "@kora/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/util/utils";
import { WorkerBox, WorkerStrip, type WorkerStanding } from "./WorkerBox";
import {
  MAX_OPEN_BOXES,
  defaultMinimized,
  settleDoneDefaults,
  workerBoxLayout,
  type SettledDefault,
} from "./workerBoxes.logic";
import "./workerBoxes.css";

/** Below this dock width the boxes stack in one column. */
const NARROW_WIDTH = 520;
/** Rows never shrink below this; past it the grid scrolls. A stacked (one-column) pane needs room for its feed,
 * a pinned approval and the steer box, so it gets more. */
const MIN_ROW_HEIGHT = 220;
const MIN_STACKED_ROW_HEIGHT = 300;

export interface WorkerBoxGridProps {
  threadRef: HostThreadRef;
  workers: ReadonlyArray<FleetWorker>;
  visible: boolean;
  advancedTypography: boolean;
  merged: ReadonlySet<string>;
  standing: (paneId: string) => WorkerStanding | null;
  /** Fill the dock with this pane (e.g. "Open terminal" from the swarm task view); bump `focusEpoch` to re-apply. */
  focusPaneId?: string | null;
  focusEpoch?: number;
  onKill: (paneId: string) => void;
  onMerge: (paneId: string) => Promise<unknown>;
  onSteer: (paneId: string, text: string) => Promise<unknown>;
}

export function WorkerBoxGrid(props: WorkerBoxGridProps) {
  const { workers } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [resizeEpoch, setResizeEpoch] = useState(0);
  // The human's minimize/restore choices; anything not chosen falls back to defaultMinimized.
  const [choice, setChoice] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? root.clientWidth;
      setNarrow(width > 0 && width < NARROW_WIDTH);
      setResizeEpoch((n) => n + 1);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!props.focusPaneId) return;
    setExpanded(props.focusPaneId);
    setChoice((prev) => new Map(prev).set(props.focusPaneId!, false));
  }, [props.focusPaneId, props.focusEpoch]);

  // Esc leaves the expanded box — but never steals Esc from a terminal (the agent CLI wants it).
  useEffect(() => {
    if (!expanded || !props.visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".wb-term")) return;
      if (!rootRef.current?.contains(target) && target !== document.body) return;
      setExpanded(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, props.visible]);

  // Done boxes keep the default they got when their turn ended (see settleDoneDefaults). Advanced while rendering
  // (React's "adjust state when a prop changes" pattern) so the first render with a new snapshot already uses it.
  const [settled, setSettled] = useState<{
    readonly workers: ReadonlyArray<FleetWorker>;
    readonly merged: ReadonlySet<string>;
    readonly map: ReadonlyMap<string, SettledDefault>;
  }>(() => ({
    workers,
    merged: props.merged,
    map: settleDoneDefaults(new Map(), workers, props.merged),
  }));
  if (settled.workers !== workers || settled.merged !== props.merged) {
    setSettled({
      workers,
      merged: props.merged,
      map: settleDoneDefaults(settled.map, workers, props.merged),
    });
  }
  const settledMap = settled.map;
  const minimized = useMemo(() => {
    const out = new Set<string>();
    const anyWorking = workers.some((w) => w.state === "working");
    for (const w of workers) {
      const chosen =
        choice.get(w.paneId) ??
        settledMap.get(w.paneId)?.minimized ??
        defaultMinimized(w, props.merged.has(w.paneId), anyWorking);
      if (chosen) out.add(w.paneId);
    }
    return out;
  }, [choice, props.merged, settledMap, workers]);

  const layout = useMemo(
    () =>
      workerBoxLayout({
        paneIds: workers.map((w) => w.paneId),
        minimized,
        expanded,
        narrow,
      }),
    [expanded, minimized, narrow, workers],
  );
  useEffect(() => {
    setResizeEpoch((n) => n + 1);
  }, [layout.open.length, layout.columns, layout.expanded]);

  const byId = useMemo(() => new Map(workers.map((w) => [w.paneId, w] as const)), [workers]);
  const setMin = useCallback((paneId: string, value: boolean) => {
    setChoice((prev) => new Map(prev).set(paneId, value));
    if (value) setExpanded((cur) => (cur === paneId ? null : cur));
  }, []);

  // Restoring a strip when the 2×2 is full trades places with the last box.
  const restore = useCallback(
    (paneId: string) => {
      setChoice((prev) => {
        const next = new Map(prev).set(paneId, false);
        const last = layout.open.at(-1);
        if (layout.open.length >= MAX_OPEN_BOXES && last && last !== paneId) next.set(last, true);
        return next;
      });
    },
    [layout.open],
  );

  const rows = layout.rows;
  const scroll = layout.columns === 1 && rows > 2;

  return (
    <div ref={rootRef} className="wb-dock" data-dark-surface="" data-worker-boxes={workers.length}>
      {layout.open.length > 0 ? (
        <div
          className={cn("wb-grid", scroll && "is-scroll")}
          style={{
            gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(${scroll ? MIN_STACKED_ROW_HEIGHT : MIN_ROW_HEIGHT}px, 1fr))`,
          }}
        >
          {layout.open.map((paneId, index) => {
            const worker = byId.get(paneId);
            if (!worker) return null;
            const spans = layout.spanLast && index === layout.open.length - 1;
            return (
              <WorkerBox
                key={paneId}
                worker={worker}
                threadRef={props.threadRef}
                visible={props.visible}
                focused={focused === paneId}
                expanded={layout.expanded === paneId}
                resizeEpoch={resizeEpoch}
                advancedTypography={props.advancedTypography}
                merged={props.merged.has(paneId)}
                standing={props.standing(paneId)}
                style={spans ? { gridColumn: "1 / -1" } : undefined}
                onFocus={() => setFocused(paneId)}
                onMinimize={() => setMin(paneId, true)}
                onToggleExpand={() => setExpanded((cur) => (cur === paneId ? null : paneId))}
                onKill={() => {
                  setExpanded((cur) => (cur === paneId ? null : cur));
                  props.onKill(paneId);
                }}
                onMerge={() => props.onMerge(paneId)}
                onSteer={(text) => props.onSteer(paneId, text)}
              />
            );
          })}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-[color:var(--wb-muted)]">
          Every worker is minimized. Pick one below to open it.
        </div>
      )}
      {layout.strips.length > 0 ? (
        <div className="wb-strips">
          {layout.strips.map((paneId) => {
            const worker = byId.get(paneId);
            if (!worker) return null;
            return (
              <WorkerStrip
                key={paneId}
                worker={worker}
                threadRef={props.threadRef}
                onRestore={() => restore(paneId)}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
