import {
  useImperativeHandle,
  useLayoutEffect,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useState,
  useRef,
  type Ref,
} from "react";

const MAX_ZOOM = 8;
const MIN_ZOOM = 1;
const KEY_PAN_STEP = 40;
const DRAG_SLOP_PX = 4;

export interface ZoomableImageHandle {
  pan: (key: string) => boolean;
}

type Size = { width: number; height: number };

function readWindowSize(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function ZoomableImage({
  src,
  name,
  onError,
  ref,
}: {
  ref?: Ref<ZoomableImageHandle>;
  onError: () => void;
  name: string;
  src: string;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [windowSize, setWindowSize] = useState<Size>(readWindowSize);
  const [natural, setNatural] = useState<Size | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [dragging, setDragging] = useState(false);

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Content-space point that must stay put under the cursor across a zoom change.
  const anchorRef = useRef<{
    contentX: number;
    contentY: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  const maxHeight = Math.max(1, Math.min(0.86 * windowSize.height, windowSize.height - 160));
  const naturalWidth = natural?.width || 1;
  const naturalHeight = natural?.height || 1;
  const fit = natural
    ? Math.min(
        1,
        (0.92 * windowSize.width - (windowSize.width >= 640 ? 96 : 0)) / naturalWidth,
        maxHeight / naturalHeight,
      )
    : 1;
  const imageWidth = natural ? natural.width * fit * zoom : undefined;
  const imageHeight = natural ? natural.height * fit * zoom : undefined;

  const changeZoom = useCallback((next: number, point?: { x: number; y: number }) => {
    const viewport = viewportRef.current;
    const current = zoomRef.current;
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (clamped === current) return;
    if (viewport) {
      const rect = viewport.getBoundingClientRect();
      const offsetX = point ? point.x - rect.left : rect.width / 2;
      const offsetY = point ? point.y - rect.top : rect.height / 2;
      anchorRef.current = {
        contentX: (viewport.scrollLeft + offsetX) / current,
        contentY: (viewport.scrollTop + offsetY) / current,
        offsetX,
        offsetY,
      };
    }
    setZoom(clamped);
  }, []);

  // After the layout grows or shrinks, scroll so the anchored point stays under the cursor.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const viewport = viewportRef.current;
    if (!anchor || !viewport) {
      return;
    }
    anchorRef.current = null;
    viewport.scrollLeft = anchor.contentX * zoom - anchor.offsetX;
    viewport.scrollTop = anchor.contentY * zoom - anchor.offsetY;
  }, [zoom]);

  useEffect(() => {
    const onResize = () => {
      setWindowSize(readWindowSize());
      setZoom(MIN_ZOOM);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Wheel needs a non-passive listener so the page does not scroll underneath.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      const delta = event.deltaY * unit;
      const rate = event.ctrlKey ? 0.01 : 0.002;
      changeZoom(zoomRef.current * Math.exp(-delta * rate), { x: event.clientX, y: event.clientY });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [changeZoom]);

  useImperativeHandle(
    ref,
    () => ({
      pan: (key: string) => {
        const viewport = viewportRef.current;
        if (!viewport || zoomRef.current <= MIN_ZOOM) return false;
        const horizontal = key === "ArrowLeft" || key === "ArrowRight";
        if (horizontal && viewport.scrollWidth <= viewport.clientWidth) return false;
        switch (key) {
          case "ArrowLeft":
            viewport.scrollLeft -= KEY_PAN_STEP;
            return true;
          case "ArrowRight":
            viewport.scrollLeft += KEY_PAN_STEP;
            return true;
          case "ArrowUp":
            viewport.scrollTop -= KEY_PAN_STEP;
            return true;
          case "ArrowDown":
            viewport.scrollTop += KEY_PAN_STEP;
            return true;
          default:
            return false;
        }
      },
    }),
    [],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || event.pointerType !== "mouse" || event.button !== 0 || zoom <= MIN_ZOOM)
      return;
    const rect = viewport.getBoundingClientRect();
    const overVerticalBar = event.clientX - rect.left >= viewport.clientWidth;
    const overHorizontalBar = event.clientY - rect.top >= viewport.clientHeight;
    if (overVerticalBar || overHorizontalBar) return;
    viewport.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      y: event.clientY,
      x: event.clientX,
      moved: false,
    };
    suppressClickRef.current = false;
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const viewport = viewportRef.current;
    if (!drag || !viewport || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > DRAG_SLOP_PX) {
      drag.moved = true;
      suppressClickRef.current = true;
    }
    viewport.scrollLeft -= dx;
    viewport.scrollTop -= dy;
    drag.x = event.clientX;
    drag.y = event.clientY;
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    setDragging(false);
  };

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.detail > 1) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    changeZoom(zoomRef.current > MIN_ZOOM ? MIN_ZOOM : 2, { x: event.clientX, y: event.clientY });
  };

  const cursor = dragging ? "cursor-grabbing" : zoom > MIN_ZOOM ? "cursor-grab" : "cursor-zoom-in";

  return (
    <div className="min-w-0">
      <div
        aria-description="Click to zoom in or return to fit. Scroll to zoom, drag to pan."
        aria-label={`${name}, zoomable image`}
        className={`max-w-(--media-width) overflow-auto overscroll-contain rounded-lg bg-background shadow-2xl outline-none ring-1 ring-border/70 focus-visible:ring-2 focus-visible:ring-ring ${cursor}`}
        onClick={onClick}
        onLostPointerCapture={endDrag}
        onPointerCancel={endDrag}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        ref={viewportRef}
        role="region"
        style={{
          width: imageWidth,
          height: imageHeight,
          maxHeight,
        }}
        tabIndex={0}
      >
        <img
          alt={name}
          className="block max-w-none select-none"
          draggable={false}
          onError={onError}
          onLoad={(event) =>
            setNatural({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          src={src}
          style={{
            width: imageWidth,
            height: imageHeight,
            maxHeight: natural ? undefined : maxHeight,
          }}
        />
      </div>
      <span aria-live="polite" className="sr-only">
        {`${Math.round(zoom * 100)}% zoom`}
      </span>
    </div>
  );
}
