import { useCallback, useEffect, useLayoutEffect, useRef, type PointerEvent } from "react";

interface ResizeSession {
  /** Runs whenever the drag ends or fails to start. */
  cleanup?: () => void;
  /** Called on commit with the last applied width. */
  finish: (wd: number, moved: boolean) => void;
  /** Applies a live width and returns the clamped width actually used. */
  resize: (wd: number) => number;
  /** Which edge of the panel the handle sits on. */
  edge: "left" | "right";
  /** Width when the drag began. */
  width: number;
}

interface ActiveDrag {
  frame: number | null;
  moved: boolean;
  width: number;
  latestX: number;
  startX: number;
  target: HTMLElement;
  pointerId: number;
  session: ResizeSession;
}

const MOVE_THRESHOLD_PX = 2;

export function useDragResize<T extends HTMLElement>(
  begin: (evt: PointerEvent<T>) => ResizeSession | null,
  resetKey?: string,
) {
  const drag = useRef<ActiveDrag | null>(null);
  const startRef = useRef(begin);
  startRef.current = begin;

  const applyLatest = (gesture: ActiveDrag) => {
    const delta = (gesture.latestX - gesture.startX) * (gesture.session.edge === "left" ? -1 : 1);
    gesture.width = gesture.session.resize(gesture.session.width + delta);
  };

  const until = useCallback((commit: boolean) => {
    const gesture = drag.current;
    if (!gesture) return;
    if (gesture.frame !== null) {
      cancelAnimationFrame(gesture.frame);
      gesture.frame = null;
    }
    if (commit) applyLatest(gesture);
    // Clear first: releasing capture can fire lostpointercapture synchronously.
    drag.current = null;
    try {
      if (gesture.target.hasPointerCapture(gesture.pointerId))
        gesture.target.releasePointerCapture(gesture.pointerId);
    } catch {
      /* already released */
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    gesture.session.cleanup?.();
    if (commit) gesture.session.finish(gesture.width, gesture.moved);
  }, []);

  const onPointerDown = useCallback((evt: PointerEvent<T>) => {
    if (evt.button !== 0 || drag.current) return;
    const sess = startRef.current(evt);
    if (!sess) return;
    const dest = evt.currentTarget;
    try {
      dest.setPointerCapture(evt.pointerId);
    } catch {
      sess.cleanup?.();
      return;
    }
    evt.preventDefault();
    evt.stopPropagation();
    drag.current = {
      frame: null,
      moved: false,
      width: sess.width,
      latestX: evt.clientX,
      startX: evt.clientX,
      target: dest,
      pointerId: evt.pointerId,
      session: sess,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const onPointerMove = useCallback((evt: PointerEvent<T>) => {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== evt.pointerId) return;
    evt.preventDefault();
    gesture.latestX = evt.clientX;
    if (Math.abs(evt.clientX - gesture.startX) > MOVE_THRESHOLD_PX) gesture.moved = true;
    if (gesture.frame === null) {
      gesture.frame = requestAnimationFrame(() => {
        gesture.frame = null;
        if (drag.current === gesture) applyLatest(gesture);
      });
    }
  }, []);

  const release = useCallback(
    (evt: PointerEvent<T>, useEventPosition: boolean) => {
      const gesture = drag.current;
      if (!gesture || gesture.pointerId !== evt.pointerId) return;
      evt.preventDefault();
      if (useEventPosition) gesture.latestX = evt.clientX;
      until(true);
    },
    [until],
  );

  const onPointerUp = useCallback((ev: PointerEvent<T>) => release(ev, true), [release]);
  const onPointerCancel = useCallback((ev: PointerEvent<T>) => release(ev, false), [release]);
  const onLostPointerCapture = useCallback((ev: PointerEvent<T>) => release(ev, false), [release]);

  useEffect(() => {
    const onBlur = () => until(true);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [until]);

  // Unmount, or a new resetKey, abandons the drag without committing.
  useLayoutEffect(() => () => until(false), [resetKey, until]);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture };
}
