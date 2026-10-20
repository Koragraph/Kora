// The live picture and the input that goes back. The canvas shows the newest frame (drawn by `useLiveBrowser`); pointer,
// wheel, key and paste events become messages whose coordinates are the REMOTE page's CSS pixels (`mapPointer`: device
// pixel ratio, zoom and the canvas' backing size never enter). The first press/wheel/key is what takes over: moving the
// pointer across the picture alone does not.

import { cn } from "~/util/utils";
import {
  mapPointerClamped,
  keyDownMessage,
  type ClientMessage,
  keyUpMessage,
  pasteMessage,
  buttonsMask,
  modifiersOf,
  wheelDeltas,
  buttonName,
  type Viewport,
} from "./browserModel";
import {
  useEffect,
  type PointerEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
  useRef,
} from "react";

export function BrowserViewport(props: {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly viewport: Viewport;
  /** False while another window drives: this one only watches. */
  readonly canDrive: boolean;
  /** The user is driving from this window right now (hover is worth sending). */
  readonly driving: boolean;
  readonly visible: boolean;
  readonly label: string;
  readonly onSend: (msg: ClientMessage) => void;
  readonly onInput: () => void;
}) {
  const { canvasRef, viewport } = props;
  const wheel = useRef({ dx: 0, dy: 0, x: 0, y: 0, raf: 0 });
  const hover = useRef({ raf: 0, x: 0, y: 0, buttons: 0 });
  const live = useRef(props);
  live.current = props;

  const point = (clientX: number, clientY: number) => {
    const el = canvasRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return mapPointerClamped(
      clientX,
      clientY,
      { left: r.left, top: r.top, width: r.width, height: r.height },
      live.current.viewport,
    );
  };

  // React attaches wheel listeners as passive, which cannot stop the page behind the panel from scrolling.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const flush = () => {
      const w = wheel.current;
      w.raf = 0;
      const { dx, dy } = w;
      w.dx = w.dy = 0;
      if (!dx && !dy) return;
      live.current.onSend({
        t: "mouse",
        type: "mouseWheel",
        x: w.x,
        y: w.y,
        deltaX: dx,
        deltaY: dy,
      });
    };
    const onWheel = (e: WheelEvent) => {
      if (!live.current.canDrive) return;
      e.preventDefault();
      live.current.onInput();
      const p = point(e.clientX, e.clientY);
      const d = wheelDeltas(e);
      const w = wheel.current;
      w.x = p.x;
      w.y = p.y;
      w.dx += d.deltaX;
      w.dy += d.deltaY;
      if (!w.raf) w.raf = requestAnimationFrame(flush); // one message per frame: a trackpad fires far more than that
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheel.current.raf) cancelAnimationFrame(wheel.current.raf);
    };
  }, [canvasRef]);

  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.focus();
    if (!props.canDrive) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events have no active pointer */
    }
    props.onInput();
    const p = point(e.clientX, e.clientY);
    props.onSend({
      t: "mouse",
      type: "mousePressed",
      ...p,
      button: buttonName(e.button),
      buttons: buttonsMask(e.buttons),
      clickCount: Math.min(3, Math.max(1, e.detail || 1)),
      modifiers: modifiersOf(e),
    });
  };
  const up = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!props.canDrive) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    props.onInput();
    const p = point(e.clientX, e.clientY);
    props.onSend({
      t: "mouse",
      type: "mouseReleased",
      ...p,
      button: buttonName(e.button),
      buttons: buttonsMask(e.buttons),
      clickCount: Math.min(3, Math.max(1, e.detail || 1)),
      modifiers: modifiersOf(e),
    });
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    const pressed = e.buttons !== 0;
    // hover is only worth sending once the user is driving (the daemon ignores it otherwise); a drag always is
    if (!props.canDrive || (!pressed && !props.driving)) return;
    if (pressed) props.onInput();
    const h = hover.current;
    h.x = e.clientX;
    h.y = e.clientY;
    h.buttons = e.buttons;
    if (h.raf) return; // coalesce to the display's frame rate
    h.raf = requestAnimationFrame(() => {
      h.raf = 0;
      const p = point(h.x, h.y);
      live.current.onSend({
        t: "mouse",
        type: "mouseMoved",
        ...p,
        button: "none",
        buttons: buttonsMask(h.buttons),
      });
    });
  };
  const keyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (!props.canDrive) return;
    const m = keyDownMessage(e.nativeEvent);
    if (!m) return;
    e.preventDefault();
    props.onInput();
    props.onSend(m);
  };
  const keyUp = (e: KeyboardEvent<HTMLCanvasElement>) => {
    if (!props.canDrive) return;
    const m = keyUpMessage(e.nativeEvent);
    if (!m) return;
    e.preventDefault();
    props.onSend(m);
  };
  const paste = (e: ClipboardEvent<HTMLCanvasElement>) => {
    if (!props.canDrive) return;
    e.preventDefault();
    const m = pasteMessage(e.clipboardData.getData("text/plain"));
    if (!m) return;
    props.onInput();
    props.onSend(m);
  };

  return (
    <canvas
      ref={canvasRef}
      width={viewport.width}
      height={viewport.height}
      tabIndex={0}
      role="application"
      aria-label={props.label}
      data-browser-canvas
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerMove={move}
      onKeyDown={keyDown}
      onKeyUp={keyUp}
      onPaste={paste}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(
        "block size-full touch-none bg-black object-contain outline-none select-none",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.visible ? "opacity-100" : "opacity-0",
        props.canDrive ? "cursor-default" : "cursor-not-allowed",
      )}
    />
  );
}
