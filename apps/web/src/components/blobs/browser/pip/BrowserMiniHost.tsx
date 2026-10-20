// Mounted once for the whole app: shows the browsing blob's mini-window on any Kora-surface screen, in the remembered
// corner of the main content area and above the composer. Renders nothing on the Code surface, in Settings, after red,
// or while that blob's full browser pane (the Computer tab) is mounted: one live socket per blob.
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { useAppSurfaceStore } from "~/components/assistant/surfaceStore";
import { useBlobPanel } from "../../chat/blobPanelStore";
import { useBlobRoster } from "../../shell/useBlobRoster";
import { BrowserMiniWindow } from "./BrowserMiniWindow";
import {
  nearestCorner,
  pipInsets,
  pipWidthFor,
  readPipCorner,
  writePipCorner,
  type PipCorner,
  type PipRect,
} from "./pipModel";
import { usePipStore } from "./pipStore";

/** The most specific visible content area (the chat column), else the page's main area, else the window. */
export const PIP_ANCHOR_SELECTOR = "[data-browser-pip-anchor]";
const FALLBACK_ANCHOR_SELECTOR = '[data-slot="sidebar-inset"]';
const COMPOSER_SELECTOR = '[data-slot="composer-host"]';

interface Frame {
  readonly anchor: PipRect;
  readonly avoid: PipRect | null;
  readonly viewport: { readonly width: number; readonly height: number };
}

const toRect = (r: DOMRect): PipRect => ({
  left: r.left,
  top: r.top,
  right: r.right,
  bottom: r.bottom,
});
const visible = (r: DOMRect) => r.width > 0 && r.height > 0;

function measure(): Frame | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  let best: DOMRect | null = null;
  for (const el of document.querySelectorAll(PIP_ANCHOR_SELECTOR)) {
    const r = el.getBoundingClientRect();
    if (visible(r) && (!best || r.width * r.height < best.width * best.height)) best = r;
  }
  if (!best) {
    const r = document.querySelector(FALLBACK_ANCHOR_SELECTOR)?.getBoundingClientRect();
    if (r && visible(r)) best = r;
  }
  const anchor: PipRect = best
    ? toRect(best)
    : { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  let avoid: PipRect | null = null;
  for (const el of document.querySelectorAll(COMPOSER_SELECTOR)) {
    const r = el.getBoundingClientRect();
    if (!visible(r) || r.right <= anchor.left || r.left >= anchor.right) continue;
    if (!avoid || r.top < avoid.top) avoid = toRect(r);
  }
  return { anchor, avoid, viewport };
}

const FALLBACK_VIEWPORT = { width: 1280, height: 800 } as const;
const sameFrame = (a: Frame | null, b: Frame | null) => JSON.stringify(a) === JSON.stringify(b);

/** Where the content area and the composer are, re-measured while the window shows (layouts move without telling). */
function useFrame(active: boolean): Frame | null {
  const [frame, setFrame] = useState<Frame | null>(() => (active ? measure() : null));
  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    const tick = () => {
      const next = measure();
      setFrame((prev) => (sameFrame(prev, next) ? prev : next));
    };
    tick();
    const t = setInterval(tick, 300);
    window.addEventListener("resize", tick);
    return () => {
      clearInterval(t);
      window.removeEventListener("resize", tick);
    };
  }, [active]);
  return frame;
}

const pip = {
  close: () => usePipStore.getState().close(),
  minimize: () => usePipStore.getState().minimize(),
  restore: () => usePipStore.getState().restore(),
  end: () => usePipStore.getState().end(),
};

export function BrowserMiniHost() {
  const [surface] = useAppSurfaceStore();
  const pathname = useLocation({ select: (l) => l.pathname });
  const navigate = useNavigate();
  const session = usePipStore((s) => s.session);
  const paneOpen = usePipStore((s) => (session ? (s.fullPanes[session.blobId] ?? 0) > 0 : false));
  const { entries } = useBlobRoster();
  const blobPanel = useBlobPanel();
  const [corner, setCorner] = useState<PipCorner>(readPipCorner);

  const show =
    session !== null &&
    session.mode !== "closed" &&
    !paneOpen &&
    surface === "blobs" &&
    !pathname.startsWith("/settings");
  const frame = useFrame(show);

  const expand = useCallback(() => {
    const s = usePipStore.getState().session;
    if (!s) return;
    usePipStore.getState().restore();
    const t = s.thread;
    if (t && pathname !== `/${t.hostId}/${t.threadId}`) {
      void navigate({
        to: "/$hostId/$threadId",
        params: { hostId: t.hostId, threadId: t.threadId },
      })
        // after the thread view settled (a narrow window closes a remembered sheet when the blob changes)
        .then(() => setTimeout(() => blobPanel.show("computer"), 0))
        .catch(() => undefined);
    } else blobPanel.show("computer");
  }, [blobPanel, navigate, pathname]);

  // no DOM to measure (tests, first frame): the window itself is the content area
  const viewport = frame?.viewport ?? FALLBACK_VIEWPORT;
  const anchor = frame?.anchor ?? {
    left: 0,
    top: 0,
    right: viewport.width,
    bottom: viewport.height,
  };
  const onDragEnd = useCallback(
    (x: number, y: number) => {
      const next = nearestCorner(x, y, anchor);
      setCorner(next);
      writePipCorner(next);
    },
    [anchor],
  );

  if (!show || !session) return null;
  const entry = entries.get(session.blobId) ?? null;
  return (
    <BrowserMiniWindow
      key={session.blobId}
      blobId={session.blobId}
      blobName={entry?.blob.name ?? "Your blob"}
      outfit={entry?.outfit}
      mode={session.mode === "minimized" ? "minimized" : "open"}
      insets={pipInsets({ anchor, avoid: frame?.avoid ?? null, corner, viewport })}
      width={pipWidthFor(anchor.right - anchor.left)}
      onClose={pip.close}
      onMinimize={pip.minimize}
      onRestore={pip.restore}
      onExpand={expand}
      onEnd={pip.end}
      onDragEnd={onDragEnd}
    />
  );
}
