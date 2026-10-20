// The floating browser mini-window: the blob's live browser as a small 16:10 picture in a corner of the content area.
// Hovering (or focusing inside) fades in a slim bar: traffic lights on the left (red = close for this browsing session,
// yellow = minimize to a pill, green = open the full browser pane) and the site's hostname on the right. When the blob
// needs the user (an approval, or the user is driving) the bar stays up with the action. Same live socket and picture as
// the full pane (`useLiveBrowser` + `BrowserViewport`): the host never mounts both for one blob.
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

import { BlobAvatar, type BlobOutfit } from "~/components/blobs/avatar";
import { cn } from "~/util/utils";
import { BrowserViewport } from "../BrowserViewport";
import { Hint, useNow } from "../parts";
import { deriveStatus, isEmptyPage, prettyUrl } from "../browserModel";
import { useLiveBrowser } from "../useLiveBrowser";
import { PIP_LINGER_MS, type PipInsets } from "./pipModel";

export interface BrowserMiniWindowProps {
  readonly blobId: string;
  readonly blobName: string;
  readonly outfit?: BlobOutfit | undefined;
  readonly mode: "open" | "minimized";
  readonly insets: PipInsets;
  readonly width: number;
  readonly onClose: () => void;
  readonly onMinimize: () => void;
  readonly onRestore: () => void;
  readonly onExpand: () => void;
  /** The browsing went quiet for a while: the host ends the session. */
  readonly onEnd: () => void;
  /** A drag of the bar ended with the box's centre here (viewport px). */
  readonly onDragEnd: (centerX: number, centerY: number) => void;
}

const LIGHT =
  "relative grid size-3 shrink-0 place-items-center rounded-full text-[9px] leading-none font-bold text-black/70 ring-1 ring-black/25 transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground";
const GLYPH =
  "pointer-events-none opacity-0 transition-opacity group-hover/lights:opacity-100 group-focus-within/lights:opacity-100 motion-reduce:transition-none";

export function BrowserMiniWindow(props: BrowserMiniWindowProps) {
  const { blobId, blobName, mode } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const live = useLiveBrowser(blobId, canvasRef);
  const { state } = live;
  const holding = state.workedUntil > Date.now();
  const statusNow = useNow(holding, 500);
  const view = deriveStatus(state, holding ? statusNow : Date.now());
  const approval = state.approvals[0] ?? null;
  const driving = state.controller === "user" && state.youControl;
  const watchingOnly = state.controller === "user" && !state.youControl;
  const needsYou = approval !== null;
  const attention = needsYou || driving;
  const activeTab = state.tabs.find((t) => t.active) ?? state.tabs[0] ?? null;
  const url = activeTab?.url ?? "";
  const host = prettyUrl(url)?.host ?? null;
  const empty = isEmptyPage(state);
  const showPicture = state.hasFrame && !empty;
  const offline = state.connection !== "open";

  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const chromeShown = hovered || focusWithin || attention;

  // Quiet for PIP_LINGER_MS (nothing working, nobody needed, socket fine) = this browsing is over.
  const onEnd = useRef(props.onEnd);
  onEnd.current = props.onEnd;
  const quiet =
    state.connection === "open" &&
    !attention &&
    state.controller === "agent" &&
    (view.status === "idle" || view.status === "closed");
  useEffect(() => {
    if (!quiet) return;
    const t = setTimeout(() => onEnd.current(), PIP_LINGER_MS);
    return () => clearTimeout(t);
  }, [quiet]);

  // ---- drag the box by its bar; it snaps to the nearest corner on release
  const box = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const onBarDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest?.("button")) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events have no active pointer */
    }
  };
  const onBarMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    setOffset({ x: dx, y: dy });
  };
  const onBarUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (!d.moved) return;
    const r = box.current?.getBoundingClientRect();
    setOffset(null);
    if (r) props.onDragEnd(r.left + r.width / 2, r.top + r.height / 2);
  };

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Escape typed into the live page while driving belongs to the page
      if (e.key !== "Escape" || e.target === canvasRef.current) return;
      e.stopPropagation();
      props.onMinimize();
    },
    [props],
  );

  if (mode === "minimized") {
    return (
      <button
        type="button"
        onClick={props.onRestore}
        aria-label={
          needsYou ? `${blobName} needs your OK: show the browser` : `Show ${blobName}'s browser`
        }
        data-browser-mini-pill
        data-browser-mini-attention={needsYou ? "needs-you" : driving ? "driving" : "none"}
        style={props.insets}
        className={cn(
          "lift fixed z-40 flex h-9 items-center gap-2 rounded-full pr-3 pl-1.5 text-[12px] font-medium text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          needsYou && "ring-1 ring-amber-400/40",
        )}
      >
        <span className="grid size-6 place-items-center overflow-hidden" aria-hidden>
          <BlobAvatar
            {...(props.outfit ? { outfit: props.outfit } : {})}
            size={24}
            still
            eyesFollowCursor={false}
          />
        </span>
        {needsYou ? (
          <span className="flex items-center gap-1.5 text-amber-200">
            <span aria-hidden className="size-1.5 rounded-full bg-amber-400" />
            needs you
          </span>
        ) : (
          <span className="text-muted-foreground">browsing</span>
        )}
      </button>
    );
  }

  return (
    <div
      ref={box}
      role="region"
      aria-label={`${blobName}'s browser, mini window`}
      data-browser-mini
      data-browser-mini-chrome={chromeShown ? "shown" : "hidden"}
      data-browser-connection={state.connection}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
      onKeyDown={onKeyDown}
      style={{
        ...props.insets,
        width: props.width,
        ...(offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : {}),
      }}
      className={cn(
        "lift fixed z-40 overflow-hidden rounded-xl ring-1",
        needsYou ? "ring-amber-400/40" : driving ? "ring-foreground/50" : "ring-border/70",
        offset
          ? "cursor-grabbing"
          : "transition-[left,right,top,bottom] motion-reduce:transition-none",
      )}
    >
      <div
        className={cn("relative aspect-[16/10] w-full", showPicture ? "bg-black" : "bg-card")}
        data-browser-stage
      >
        <BrowserViewport
          canvasRef={canvasRef}
          viewport={state.viewport}
          canDrive={!offline && state.running && !watchingOnly && showPicture}
          driving={driving}
          visible={showPicture}
          label={`${blobName}'s browser. Click to take over.`}
          onSend={live.send}
          onInput={live.noteInput}
        />
        {!showPicture ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-[12px] text-muted-foreground">
            {offline
              ? state.connection === "unavailable"
                ? "Couldn't connect"
                : "Connecting…"
              : `${blobName} is opening the browser…`}
          </div>
        ) : null}

        {/* the hover bar */}
        <div
          onPointerDown={onBarDown}
          onPointerMove={onBarMove}
          onPointerUp={onBarUp}
          onPointerCancel={onBarUp}
          data-browser-mini-bar
          className={cn(
            "absolute inset-x-0 top-0 flex h-8 cursor-grab items-center gap-2 bg-gradient-to-b from-black/80 to-black/0 px-2.5 transition-opacity duration-150 motion-reduce:transition-none",
            chromeShown ? "opacity-100" : "opacity-0",
          )}
        >
          <div className="group/lights flex items-center gap-1.5">
            <button
              type="button"
              aria-label={`Close ${blobName}'s browser window`}
              onClick={props.onClose}
              data-browser-mini-close
              className={cn(LIGHT, "bg-red-500")}
            >
              <span aria-hidden className={GLYPH}>
                ×
              </span>
            </button>
            <button
              type="button"
              aria-label={`Minimize ${blobName}'s browser window`}
              onClick={props.onMinimize}
              data-browser-mini-minimize
              className={cn(LIGHT, "bg-amber-400")}
            >
              <span aria-hidden className={GLYPH}>
                −
              </span>
            </button>
            <button
              type="button"
              aria-label={`Open ${blobName}'s full browser`}
              onClick={props.onExpand}
              data-browser-mini-expand
              className={cn(LIGHT, "bg-green-500")}
            >
              <span aria-hidden className={GLYPH}>
                +
              </span>
            </button>
          </div>
          <span className="min-w-0 flex-1" />
          {host ? (
            <Hint
              hint={url}
              render={
                <span
                  className="min-w-0 max-w-[60%] truncate text-[11.5px] font-medium text-foreground/90"
                  data-browser-mini-host
                />
              }
            >
              {host}
            </Hint>
          ) : null}
        </div>

        {/* the needs-you / driving strip: always visible, the action is right here */}
        {needsYou ? (
          <div
            role="status"
            aria-live="polite"
            data-browser-mini-needs-you
            className="absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-lg bg-black/85 px-2.5 py-1.5 text-[12px] ring-1 ring-amber-400/40"
          >
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-400" />
            <span className="min-w-0 flex-1 truncate text-amber-100">{blobName} needs your OK</span>
            <button
              type="button"
              onClick={props.onExpand}
              aria-label={`Open ${blobName}'s browser to answer`}
              data-browser-mini-open
              className="h-6 shrink-0 rounded-md bg-foreground px-2 text-[11.5px] font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open
            </button>
          </div>
        ) : driving ? (
          <div
            role="status"
            aria-live="polite"
            data-browser-mini-driving
            className="absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-lg bg-black/85 px-2.5 py-1.5 text-[12px] ring-1 ring-border/70"
          >
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-green-400" />
            <span className="min-w-0 flex-1 truncate text-foreground">You're driving</span>
            <button
              type="button"
              onClick={() => live.send({ t: "release" })}
              aria-label={`Hand the browser back to ${blobName}`}
              data-browser-mini-handback
              className="h-6 shrink-0 rounded-md bg-foreground px-2 text-[11.5px] font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Hand back
            </button>
          </div>
        ) : view.status === "working" && !chromeShown ? (
          <span
            aria-hidden
            className="absolute right-2 bottom-2 size-1.5 rounded-full bg-foreground motion-safe:animate-pulse"
          />
        ) : null}
      </div>
    </div>
  );
}
