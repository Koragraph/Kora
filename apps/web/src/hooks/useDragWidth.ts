import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";
import { useDragResize } from "./useDragResize";

export interface UseResizableWidthOptions {
  readonly edge: "left" | "right";
  readonly maxWidth: number;
  readonly minWidth: number;
  readonly defaultWidth: number;
  readonly storageKey: string;
}

export interface ResizableWidthHandlers {
  onPointerDown: (evt: PointerEvent<HTMLElement>) => void;
  onPointerMove: (evt: PointerEvent<HTMLElement>) => void;
  onPointerUp: (evt: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (evt: PointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (evt: PointerEvent<HTMLElement>) => void;
}

const clampTo = (val: number, min: number, max: number) => Math.min(max, Math.max(min, val));

function loadWidth(keyName: string, backup: number): number {
  if (typeof window === "undefined") return backup;
  try {
    const persistedVal = getLocalStorageItem(keyName, Schema.Finite);
    return persistedVal !== null && Number.isFinite(persistedVal) ? persistedVal : backup;
  } catch (err) {
    console.error("Could not read persisted panel width.", err);
    return backup;
  }
}

export function useResizableWidth(opts: UseResizableWidthOptions): {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
} {
  const { storageKey, defaultWidth, minWidth, maxWidth, edge } = opts;
  const [state, setState] = useState(() => ({
    key: storageKey,
    width: loadWidth(storageKey, defaultWidth),
  }));

  // Panels stay mounted across threads: re-read for a new key before the next paint.
  if (state.key !== storageKey) {
    setState({ key: storageKey, width: loadWidth(storageKey, defaultWidth) });
  }

  const wd = clampTo(state.width, minWidth, maxWidth);
  const live = useRef({ width: wd, minWidth, maxWidth, storageKey });
  useLayoutEffect(() => {
    live.current = { width: wd, minWidth, maxWidth, storageKey };
  });

  const begin = useCallback(() => {
    const { width: startWidth, storageKey: key } = live.current;
    return {
      width: startWidth,
      edge,
      resize: (upcoming: number) => {
        const applied = clampTo(upcoming, live.current.minWidth, live.current.maxWidth);
        setState({ key, width: applied });
        return applied;
      },
      // One write at drag end, not ~60 per second.
      finish: (final: number) => {
        try {
          setLocalStorageItem(key, final, Schema.Finite);
        } catch (err) {
          console.error("Could not persist panel width.", err);
        }
      },
    };
  }, [edge]);

  const handlers = useDragResize<HTMLElement>(begin, storageKey);
  return { width: wd, handlers };
}
