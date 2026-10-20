import {
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useState,
  useRef,
  useMemo,
  useEffect,
  useCallback,
} from "react";
import type { WebViewportSetting, WebViewportSize } from "@kora/contracts";

import {
  type BrowserViewportResizeDirection,
  type BrowserViewportLayout,
  resolveBrowserViewportLayout,
  resolveBrowserDeviceViewportLayout,
  resolveBrowserDeviceViewportArea,
  resizeFreeformViewport,
  resizeBrowserViewportFromRail,
  browserViewportSettingKey,
} from "./browserViewportLayout";
import { commitBrowserViewportChange } from "./browserViewportActions";

const KEYBOARD_COMMIT_DELAY_MS = 150;
const KEY_STEP_PX = 10;
const KEY_STEP_SHIFT_PX = 50;

type Transient = WebViewportSize & {
  readonly sourceKey: string;
  readonly direction: BrowserViewportResizeDirection;
};

const toFreeform = (extent: WebViewportSize): WebViewportSetting => ({
  _tag: "freeform",
  width: extent.width,
  height: extent.height,
});

const KEY_DELTA: Record<string, { x: number; y: number }> = {
  ArrowRight: { x: 1, y: 0 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowDown: { x: 0, y: 1 },
  ArrowUp: { x: 0, y: -1 },
};

export function useBrowserViewportResize(opts: {
  readonly tabId: string;
  readonly viewport: WebViewportSetting;
  readonly zoomFactor: number;
  readonly containerSize: WebViewportSize;
  readonly deviceToolbarVisible: boolean;
  readonly aspectRatio: number | null;
}): {
  activeDrag: Transient | null;
  commitViewportChange: (upcoming: WebViewportSetting) => Promise<void>;
  effectiveViewport: WebViewportSetting;
  handleResizeKeyDown: (
    dir: BrowserViewportResizeDirection,
    evt: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  handleResizePointerDown: (
    dir: BrowserViewportResizeDirection,
    evt: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  layout: BrowserViewportLayout;
} {
  const { tabId, viewport, zoomFactor, containerSize, deviceToolbarVisible, aspectRatio } = opts;
  const [transient, setTransient] = useState<Transient | null>(null);

  const committedKey = browserViewportSettingKey(viewport);
  const live = useRef({
    committedKey,
    viewport,
    zoomFactor,
    containerSize,
    deviceToolbarVisible,
    aspectRatio,
  });
  live.current = {
    committedKey,
    viewport,
    zoomFactor,
    containerSize,
    deviceToolbarVisible,
    aspectRatio,
  };

  // The transient size only counts while the committed setting it was based on still stands.
  const activeDrag = transient && transient.sourceKey === committedKey ? transient : null;
  const effectiveViewport: WebViewportSetting = activeDrag ? toFreeform(activeDrag) : viewport;

  const arrangement = useMemo(
    () =>
      deviceToolbarVisible && effectiveViewport._tag !== "fill"
        ? resolveBrowserDeviceViewportLayout(containerSize, effectiveViewport, zoomFactor)
        : resolveBrowserViewportLayout(containerSize, effectiveViewport, zoomFactor),
    [containerSize, deviceToolbarVisible, effectiveViewport, zoomFactor],
  );
  const layoutRef = useRef(arrangement);
  layoutRef.current = arrangement;

  // A newer gesture bumps the version so an older commit cannot clear its transient.
  const version = useRef(0);
  const stopDrag = useRef<(() => void) | null>(null);
  const keyboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardSize = useRef<{ sourceKey: string; size: WebViewportSize } | null>(null);

  const cancelKeyboard = useCallback(() => {
    if (keyboardTimer.current !== null) clearTimeout(keyboardTimer.current);
    keyboardTimer.current = null;
    keyboardSize.current = null;
  }, []);

  const availableArea = useCallback((): WebViewportSize => {
    const { containerSize: container, deviceToolbarVisible: toolbar } = live.current;
    return toolbar ? resolveBrowserDeviceViewportArea(container) : (container as WebViewportSize);
  }, []);

  const handleResizePointerDown = useCallback(
    (dir: BrowserViewportResizeDirection, evt: ReactPointerEvent<HTMLButtonElement>) => {
      const current = live.current;
      if (current.viewport._tag === "fill") return;
      evt.preventDefault();
      evt.stopPropagation();
      cancelKeyboard();
      stopDrag.current?.();

      const mine = ++version.current;
      const sourceKey = current.committedKey;
      const begin: WebViewportSize = {
        width: current.viewport.width,
        height: current.viewport.height,
      } as WebViewportSize;
      const startX = evt.clientX;
      const startY = evt.clientY;
      // Pointer pixels map to CSS pixels only after undoing the fit-to-panel scale.
      const dragZoom = current.zoomFactor * layoutRef.current.viewportScale;
      const pointerId = evt.pointerId;
      const dest = evt.currentTarget;
      try {
        dest.setPointerCapture(pointerId);
      } catch {
        /* window listeners still carry the drag */
      }

      let extent = begin;
      setTransient({ ...begin, sourceKey, direction: dir });

      const finish = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        try {
          dest.releasePointerCapture(pointerId);
        } catch {
          /* already released */
        }
        if (stopDrag.current === abort) stopDrag.current = null;
      };
      const abort = () => {
        finish();
        if (version.current === mine) setTransient(null);
      };
      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== pointerId) return;
        if (live.current.committedKey !== sourceKey) {
          abort();
          return;
        }
        move.preventDefault();
        extent = resizeBrowserViewportFromRail(
          begin,
          { x: move.clientX - startX, y: move.clientY - startY },
          availableArea(),
          dragZoom,
          dir,
          live.current.aspectRatio ?? undefined,
        );
        setTransient({ ...extent, sourceKey, direction: dir });
      };
      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== pointerId) return;
        finish();
        const unchanged = extent.width === begin.width && extent.height === begin.height;
        if (live.current.committedKey !== sourceKey || unchanged) {
          if (version.current === mine) setTransient(null);
          return;
        }
        const clear = () => {
          if (version.current === mine) setTransient(null);
        };
        commitBrowserViewportChange(tabId, toFreeform(extent)).then(clear, clear);
      };
      const onCancel = (cancel: PointerEvent) => {
        if (cancel.pointerId === pointerId) abort();
      };

      stopDrag.current = abort;
      // Non-passive, so the move can preventDefault.
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    [availableArea, cancelKeyboard, tabId],
  );

  const handleResizeKeyDown = useCallback(
    (dir: BrowserViewportResizeDirection, evt: ReactKeyboardEvent<HTMLButtonElement>) => {
      const current = live.current;
      if (current.viewport._tag === "fill") return;
      const unitVal = KEY_DELTA[evt.key];
      if (!unitVal) return;
      const horizontal = dir.includes("east") || dir.includes("west");
      const vertical = dir.includes("north") || dir.includes("south");
      if ((unitVal.x !== 0 && !horizontal) || (unitVal.y !== 0 && !vertical)) return;
      evt.preventDefault();
      evt.stopPropagation();

      const step = (evt.shiftKey ? KEY_STEP_SHIFT_PX : KEY_STEP_PX) * current.zoomFactor;
      const queued = keyboardSize.current;
      const fallbackBase: WebViewportSize =
        queued && queued.sourceKey === current.committedKey
          ? queued.size
          : ({ width: current.viewport.width, height: current.viewport.height } as WebViewportSize);
      const upcoming = resizeFreeformViewport(
        fallbackBase,
        { x: unitVal.x * step, y: unitVal.y * step },
        current.zoomFactor,
        dir,
        current.aspectRatio ?? undefined,
      );
      if (upcoming.width === fallbackBase.width && upcoming.height === fallbackBase.height) return;

      const sourceKey = current.committedKey;
      keyboardSize.current = { sourceKey, size: upcoming };
      setTransient({ ...upcoming, sourceKey, direction: dir });
      if (keyboardTimer.current !== null) clearTimeout(keyboardTimer.current);
      keyboardTimer.current = setTimeout(() => {
        keyboardTimer.current = null;
        const pendingNow = keyboardSize.current;
        keyboardSize.current = null;
        if (!pendingNow || live.current.committedKey !== pendingNow.sourceKey) return;
        const clear = () => setTransient(null);
        commitBrowserViewportChange(tabId, toFreeform(pendingNow.size)).then(clear, clear);
      }, KEYBOARD_COMMIT_DELAY_MS);
    },
    [tabId],
  );

  const commitViewportChange = useCallback(
    (upcoming: WebViewportSetting) => {
      version.current += 1;
      stopDrag.current?.();
      cancelKeyboard();
      setTransient(null);
      return commitBrowserViewportChange(tabId, upcoming);
    },
    [cancelKeyboard, tabId],
  );

  // A pending keyboard commit for an older setting is moot once the setting changes.
  useEffect(() => {
    if (keyboardSize.current && keyboardSize.current.sourceKey !== committedKey) cancelKeyboard();
  }, [cancelKeyboard, committedKey]);

  useEffect(
    () => () => {
      version.current += 1;
      stopDrag.current?.();
      cancelKeyboard();
    },
    [cancelKeyboard],
  );

  return {
    layout: arrangement,
    handleResizePointerDown,
    handleResizeKeyDown,
    effectiveViewport,
    commitViewportChange,
    activeDrag,
  };
}
