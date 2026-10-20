/**
 * The floating window a blob opens (SwarmBlobDock.tsx): a portal to `document.body` so opening or
 * closing it never touches the chat canvas's own layout (that in-flow/absolute positioning was the
 * cause of the old slide-pane's "shake" — see the module doc below). Its content is the same worker
 * pane as the dock's grid (fleet/WorkerBox, `variant="window"`): the chat-like feed, approvals, steer
 * and the same traffic lights — red stops the worker, yellow tucks the window back into its sprite,
 * green maximizes — plus tabs (Activity · Terminal where a PTY exists · Report · Transcript). Never a
 * bare terminal for a GUI worker. The title bar drags; Esc closes. SwarmBlobDock keeps this component
 * mounted for as long as any pane is open and just changes its `worker` prop when the selection changes.
 *
 * ## What caused the shake
 * Two compounding bugs in the old `WorkerSlidePane`:
 *  1. `TerminalViewport`'s autoFocus effect called `containerRef.current?.focus()` with no
 *     `{ preventScroll: true }` while the pane was still mid-entrance-animation (translated off the
 *     right edge of the viewport). Focusing an element outside the visible area makes the browser
 *     scroll its nearest scrollable ancestor to reveal it — a sudden jump layered on top of the
 *     slide-in transform read as a "shake". `ThreadTerminalPanel.tsx`'s other focus call sites
 *     already guard with `preventScroll`; only this one didn't.
 *  2. `SwarmBlobDock`'s own dock shifted sideways (`right: 14px` → `calc(paneWidth + 14px)`, a
 *     260ms transition) whenever a pane opened, moving *other* on-screen content at the same time
 *     the pane slid in. A `position: fixed` portal removes both causes: nothing in the chat canvas
 *     (dock included) moves when this window opens, and the window itself is never off-screen, so
 *     there is nothing for the browser to auto-scroll toward.
 */
/** Remembered across opens/closes for the lifetime of the tab — deliberately not persisted. */

import { WorkerBox } from "~/components/fleet/WorkerBox";
import "~/components/fleet/workerBoxes.css";
import {
  maximizedWorkerWindowFrame,
  clampWorkerWindowPosition,
  defaultWorkerWindowFrame,
  type WindowFrame,
} from "./workerWindowLayout";
import type { HostThreadRef, FleetWorker } from "@kora/contracts";
import { createPortal } from "react-dom";
import {
  type AnimationEvent as ReactAnimationEvent,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useState,
  useMemo,
  useRef,
} from "react";

let rememberedFrame: WindowFrame | null = null;

function viewportSize() {
  const width = typeof window !== "undefined" ? (window.innerWidth ?? 1280) : 1280;
  const height = typeof window !== "undefined" ? (window.innerHeight ?? 800) : 800;
  return { width, height };
}

const EXIT_ANIMATION_MS = 180;

export interface WorkerFloatingWindowProps {
  readonly threadRef: HostThreadRef;
  readonly worker: FleetWorker;
  readonly onClose: () => void;
  readonly onKill: () => void;
  readonly onSteer: (text: string) => Promise<unknown>;
  /** Merge the worker's branch (fleet.merge); omitted hides nothing — the pane's Merge card just no-ops. */
  readonly onMerge?: () => Promise<unknown>;
  /** The branch is already merged (FleetPanel `mergedPaneIds`). */
  readonly merged?: boolean;
  /** Opens the shared blob action menu (blobMenu.ts) — the "⋯" button's twin to a blob's
   *  right-click. Omitted entirely hides the button. */
  readonly onOpenMenu?: (position: { x: number; y: number }) => void;
}

export function WorkerFloatingWindow({
  threadRef,
  worker,
  onClose,
  onKill,
  onSteer,
  onMerge,
  merged = false,
  onOpenMenu,
}: WorkerFloatingWindowProps) {
  const [frame, setFrame] = useState<WindowFrame>(
    () => rememberedFrame ?? defaultWorkerWindowFrame(viewportSize()),
  );
  const [maximized, setMaximized] = useState(false);
  const [exiting, setExiting] = useState<"close" | "minimize" | null>(null);
  const [fitEpoch, setFitEpoch] = useState(0);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);

  const displayFrame = maximized ? maximizedWorkerWindowFrame(viewportSize()) : frame;

  useEffect(() => {
    rememberedFrame = frame;
  }, [frame]);

  // A resize can strand the window off-screen (e.g. a maximized frame after a viewport shrink);
  // re-clamp instead of re-fitting the terminal on every pixel.
  useEffect(() => {
    function onResize() {
      const viewport = viewportSize();
      if (!maximized) {
        setFrame(
          (current) =>
            ({
              ...current,
              ...clampWorkerWindowPosition(current, current, viewport),
            }) as WindowFrame,
        );
      }
      setFitEpoch((epoch) => epoch + 1);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [maximized]);

  const exitingRef = useRef(false);
  const beginExit = useCallback(
    (kind: "close" | "minimize") => {
      if (exitingRef.current) return;
      exitingRef.current = true;
      setExiting(kind);
      window.setTimeout(onClose, EXIT_ANIMATION_MS);
    },
    [onClose],
  );

  const minimize = useCallback(() => beginExit("minimize"), [beginExit]);

  const onDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || maximized) return;
      const target = event.target as HTMLElement;
      if (target.closest("button, input, a")) return;
      dragRef.current = {
        pointerId: event.pointerId,
        offsetX: event.clientX - displayFrame.x,
        offsetY: event.clientY - displayFrame.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [displayFrame.x, displayFrame.y, maximized],
  );

  const onDragPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const viewport = viewportSize();
    setFrame(
      (current) =>
        ({
          ...current,
          ...clampWorkerWindowPosition(
            { x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY },
            current,
            viewport,
          ),
        }) as WindowFrame,
    );
  }, []);

  const onDragPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }, []);

  const onEntranceAnimationEnd = useCallback((event: ReactAnimationEvent<HTMLDivElement>) => {
    if (event.animationName !== "worker-window-in") return;
    setFitEpoch((epoch) => epoch + 1);
  }, []);

  const toggleMaximize = useCallback(() => {
    setMaximized((current) => {
      const next = !current;
      if (!next) setFrame(defaultWorkerWindowFrame(viewportSize()));
      return next;
    });
    setFitEpoch((epoch) => epoch + 1);
  }, []);

  const style = useMemo<CSSProperties>(
    () => ({
      left: displayFrame.x,
      top: displayFrame.y,
      width: displayFrame.width,
      height: displayFrame.height,
    }),
    [displayFrame.height, displayFrame.width, displayFrame.x, displayFrame.y],
  );

  const portalTarget = typeof document !== "undefined" ? document.body : null;
  if (!portalTarget) return null;

  const titlebarProps = {
    onPointerDown: onDragPointerDown,
    onPointerMove: onDragPointerMove,
    onPointerUp: onDragPointerUp,
    tabIndex: -1,
  };

  return createPortal(
    <div
      className="swarm-worker-window wb-dock is-window"
      data-dark-surface=""
      data-worker-window={worker.paneId}
      data-exiting={exiting ?? undefined}
      data-maximized={maximized}
      style={style}
      onAnimationEnd={onEntranceAnimationEnd}
      onKeyDown={(event) => {
        // Esc anywhere in the window closes it — except inside a terminal (the agent CLI wants Esc).
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if ((event.target as Element | null)?.closest?.(".wb-term")) return;
        beginExit("close");
      }}
    >
      <WorkerBox
        key={worker.paneId}
        variant="window"
        worker={worker}
        threadRef={threadRef}
        visible={exiting === null}
        focused
        expanded={maximized}
        resizeEpoch={fitEpoch + displayFrame.height + displayFrame.width}
        advancedTypography={false}
        merged={merged}
        standing={null}
        titlebarProps={titlebarProps}
        {...(onOpenMenu ? { onOpenMenu } : {})}
        onFocus={noop}
        onMinimize={minimize}
        onToggleExpand={toggleMaximize}
        onKill={onKill}
        onMerge={onMerge ?? resolved}
        onSteer={onSteer}
      />
    </div>,
    portalTarget,
  );
}

const noop = () => undefined;
const resolved = () => Promise.resolve();
