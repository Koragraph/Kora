export type SelectionActionPoint = { x: number; y: number };

/** A double/triple click needs this long to settle before the popup may open. */
export const SELECTION_MULTI_CLICK_INTERVAL_MS = 500;

const VIEWPORT_MARGIN = 8;
const FALLBACK_RIGHT_INSET = 140;

function clampAxis(val: number, low: number, high: number, viewportLimit: number): number {
  return Math.max(
    VIEWPORT_MARGIN,
    Math.min(Math.max(low, Math.min(val, high)), viewportLimit - VIEWPORT_MARGIN),
  );
}

export function resolveSelectionActionPosition(opts: {
  viewport: { width: number; height: number };
  pointer: SelectionActionPoint | null;
  selectionRect: { right: number; bottom: number } | null;
  bounds: { left: number; top: number; width: number; height: number };
}): SelectionActionPoint {
  const { bounds, selectionRect, pointer, viewport } = opts;
  const preferred: SelectionActionPoint =
    pointer ??
    (selectionRect
      ? { x: selectionRect.right, y: selectionRect.bottom + 4 }
      : { x: bounds.left + bounds.width - FALLBACK_RIGHT_INSET, y: bounds.top + 12 });
  return {
    x: clampAxis(preferred.x, bounds.left, bounds.left + bounds.width, viewport.width),
    y: clampAxis(preferred.y, bounds.top, bounds.top + bounds.height, viewport.height),
  };
}

type DismissReason = "interaction" | "cancel";

/**
 * Opens a selection action shortly after the pointer is released, leaving multi-clicks time to
 * finish. The surface says how to read and act on its selection; this owns the event timing.
 */
export function observeSelectionActions(argv: {
  element: HTMLElement;
  getActionElement?: () => HTMLElement | null;
  onSelection: (ptr: SelectionActionPoint | null) => void;
  onDismiss: (reason: DismissReason) => void;
}): { readonly pending: boolean; cancel(): void; selectionChanged(): void; dispose(): void } {
  const { element, getActionElement, onSelection, onDismiss } = argv;
  const doc = element.ownerDocument;
  const surfaceView = doc.defaultView!;

  let dismissed = false;
  let gestureActive = false;
  let pointerDown = false;
  let ptr: SelectionActionPoint | null = null;
  let tmr: number | null = null;
  let fr: number | null = null;

  const inAction = (dest: unknown) => {
    const actionName = getActionElement?.();
    return !!actionName && actionName.contains(dest as Node | null);
  };

  const cancelPending = () => {
    if (tmr !== null) surfaceView.clearTimeout(tmr);
    if (fr !== null) surfaceView.cancelAnimationFrame(fr);
    tmr = null;
    fr = null;
  };

  const schedule = (delay: number) => {
    cancelPending();
    tmr = surfaceView.setTimeout(() => {
      tmr = null;
      fr = surfaceView.requestAnimationFrame(() => {
        fr = null;
        onSelection(ptr);
      });
    }, delay);
  };

  const cancel = () => {
    cancelPending();
    dismissed = true;
    ptr = null;
    gestureActive = false;
    pointerDown = false;
  };

  const dismiss = () => {
    cancel();
    return onDismiss("cancel");
  };

  const onDocPointerDown = (evt: Event) => {
    const ev = evt as PointerEvent;
    if (ev.isPrimary === false) return;
    // Editing inside an interactive popover must not replace the source selection.
    if (inAction(ev.target)) {
      cancel();
      return;
    }
    cancelPending();
    pointerDown = ev.button === 0;
    gestureActive = false;
    dismissed = true;
    ptr = null;
    if (element.contains(ev.target as Node | null)) onDismiss("interaction");
    else if (getActionElement?.()) onDismiss("cancel");
  };

  const onElementPointerDown = (evt: Event) => {
    const ev = evt as PointerEvent;
    if (ev.isPrimary === false) return;
    // A surface may consume the press (link, terminal mouse reporting).
    gestureActive = ev.button === 0 && !ev.defaultPrevented;
    dismissed = !gestureActive;
  };

  const onPointerUp = (evt: Event) => {
    const ev = evt as PointerEvent;
    if (ev.isPrimary === false || ev.button !== 0) return;
    pointerDown = false; // mouseup can be swallowed when pointerdown was prevented
  };

  const onMouseUp = (evt: Event) => {
    const ev = evt as MouseEvent;
    if (ev.button !== 0) return;
    const wasGesture = gestureActive;
    pointerDown = false;
    if (!wasGesture) return;
    gestureActive = false;
    ptr = { x: ev.clientX, y: ev.clientY };
    schedule(ev.detail >= 2 ? SELECTION_MULTI_CLICK_INTERVAL_MS : 0);
  };

  const onKeyDown = (evt: Event) => {
    if (inAction(evt.target) || pointerDown) return;
    cancelPending();
    gestureActive = false;
    ptr = null;
    dismissed = false;
  };

  const onFocusIn = (evt: Event) => {
    if (inAction(evt.target)) cancel();
    else if (!pointerDown && getActionElement?.()) dismiss();
  };

  const onScroll = () => {
    cancelPending();
    // Autoscroll while dragging must not cancel that drag's eventual release.
    if (!pointerDown) [ptr, dismissed] = [null, true];
    onDismiss("cancel");
  };

  const onContextMenu = () => {
    cancel();
    return onDismiss("interaction");
  };

  const listeners: Array<[EventTarget, string, EventListener, boolean?]> = [
    [doc, "pointerdown", onDocPointerDown, true],
    [element, "pointerdown", onElementPointerDown],
    [surfaceView, "pointerup", onPointerUp],
    [surfaceView, "mouseup", onMouseUp],
    [doc, "keydown", onKeyDown],
    [doc, "focusin", onFocusIn],
    [element, "scroll", onScroll, true],
    [element, "contextmenu", onContextMenu, true],
    [surfaceView, "pointercancel", dismiss],
    [surfaceView, "blur", dismiss],
    [surfaceView, "resize", dismiss],
  ];
  for (const [target, type, handler, capture] of listeners) {
    target.addEventListener(type, handler, capture);
  }

  return {
    get pending() {
      return tmr !== null || fr !== null;
    },
    cancel,
    selectionChanged() {
      if (inAction(doc.activeElement)) return;
      if (pointerDown || gestureActive) {
        onDismiss("cancel");
        return;
      }
      if (!dismissed && tmr === null && fr === null) schedule(0);
    },
    dispose() {
      cancelPending();
      for (const [target, type, handler, capture] of listeners) {
        target.removeEventListener(type, handler, capture);
      }
    },
  };
}
