// One blob's live browser: connects while the panel is mounted and visible, keeps the daemon's state in a reducer, draws
// the freshest frame to the canvas (an older frame still decoding is skipped, never queued), reconnects with backoff,
// and measures fps and round-trip time. The socket closes when the panel unmounts or the window is hidden: the daemon
// stops the screencast with the last viewer, so a closed panel costs nothing.
import { useCallback, useEffect, useReducer, useRef, useState, type RefObject } from "react";

import { useLiveConnector, type LiveConnection } from "./liveConnection";
import {
  browserReducer,
  initialBrowserState,
  parseServerMessage,
  type BrowserState,
  type ClientMessage,
} from "./browserModel";

export interface LiveStats {
  readonly fps: number;
  readonly rttMs: number | null;
  readonly framesDrawn: number;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const PING_EVERY_MS = 8000;

export interface LiveBrowser {
  readonly state: BrowserState;
  readonly stats: LiveStats;
  send(msg: ClientMessage): void;
  /** Call on every user input: feeds the hand-back countdown. */
  noteInput(): void;
  readonly lastInputAt: number;
  retry(): void;
}

export function useLiveBrowser(
  blobId: string,
  canvasRef: RefObject<HTMLCanvasElement | null>,
): LiveBrowser {
  const connector = useLiveConnector();
  const [state, dispatch] = useReducer(browserReducer, initialBrowserState);
  const [stats, setStats] = useState<LiveStats>({ fps: 0, rttMs: null, framesDrawn: 0 });
  const conn = useRef<LiveConnection | null>(null);
  const lastInput = useRef(0);
  const [lastInputAt, setLastInputAt] = useState(0);
  const attempt = useRef(0);
  const failures = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [generation, setGeneration] = useState(0);
  const counters = useRef({ drawn: 0, windowDrawn: 0, windowStart: 0, rtt: null as number | null });

  const send = useCallback((msg: ClientMessage) => {
    conn.current?.send(JSON.stringify(msg));
  }, []);
  const noteInput = useCallback(() => {
    lastInput.current = Date.now();
    setLastInputAt(lastInput.current);
  }, []);
  const retry = useCallback(() => {
    failures.current = 0;
    attempt.current = 0;
    setGeneration((g) => g + 1);
  }, []);

  useEffect(() => {
    let disposed = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let statTimer: ReturnType<typeof setInterval> | null = null;
    let decoding = false;
    let pending: ArrayBuffer | null = null;

    const draw = async () => {
      if (decoding) return;
      decoding = true;
      try {
        while (pending && !disposed) {
          const buf = pending;
          pending = null; // whatever arrived while decoding replaces this: latest wins
          const canvas = canvasRef.current;
          if (!canvas || typeof createImageBitmap !== "function") continue;
          let bmp: ImageBitmap;
          try {
            bmp = await createImageBitmap(new Blob([buf], { type: "image/jpeg" }));
          } catch {
            continue; // a truncated frame: the next one repairs it
          }
          if (disposed) {
            bmp.close();
            return;
          }
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
          }
          canvas.getContext("2d")?.drawImage(bmp, 0, 0);
          bmp.close();
          counters.current.drawn++;
          counters.current.windowDrawn++;
          dispatch({ type: "frame" });
        }
      } finally {
        decoding = false;
      }
    };

    const connect = () => {
      if (disposed) return;
      dispatch({
        type: "connection",
        connection:
          failures.current >= 3
            ? "unavailable"
            : attempt.current === 0 && failures.current === 0
              ? "connecting"
              : "reconnecting",
      });
      const c = connector(blobId, {
        onOpen: () => {
          attempt.current = 0;
          failures.current = 0;
          dispatch({ type: "connection", connection: "open" });
          c.send(JSON.stringify({ t: "ping", ts: performance.now() }));
        },
        onText: (raw) => {
          const m = parseServerMessage(raw);
          if (!m) return;
          if (m.t === "pong") {
            counters.current.rtt = Math.max(0, Math.round(performance.now() - m.ts));
            return;
          }
          dispatch({ type: "message", message: m });
        },
        onFrame: (buf) => {
          pending = buf;
          void draw();
        },
        onClose: ({ wasOpen }) => {
          if (disposed) return;
          conn.current = null;
          if (!wasOpen) failures.current++;
          dispatch({
            type: "connection",
            connection: failures.current >= 3 ? "unavailable" : "reconnecting",
          });
          const wait =
            failures.current >= 3
              ? 15_000
              : (BACKOFF_MS[Math.min(attempt.current, BACKOFF_MS.length - 1)] ?? 8000);
          attempt.current++;
          retryTimer.current = setTimeout(connect, wait);
        },
      });
      conn.current = c;
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (retryTimer.current) clearTimeout(retryTimer.current);
        const c = conn.current;
        conn.current = null;
        // hidden window: stop the stream (the daemon hands control back when the last viewer leaves); a deliberate close does not retry
        c?.close();
      } else if (!conn.current) {
        attempt.current = 0;
        connect();
      }
    };

    counters.current.windowStart = performance.now();
    statTimer = setInterval(() => {
      const now = performance.now();
      const secs = (now - counters.current.windowStart) / 1000;
      const fps = secs > 0 ? Math.round((counters.current.windowDrawn / secs) * 10) / 10 : 0;
      counters.current.windowDrawn = 0;
      counters.current.windowStart = now;
      setStats((p) =>
        p.fps === fps &&
        p.rttMs === counters.current.rtt &&
        p.framesDrawn === counters.current.drawn
          ? p
          : { fps, rttMs: counters.current.rtt, framesDrawn: counters.current.drawn },
      );
    }, 1000);
    pingTimer = setInterval(
      () => conn.current?.send(JSON.stringify({ t: "ping", ts: performance.now() })),
      PING_EVERY_MS,
    );
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", onVisibility);
    connect();
    return () => {
      disposed = true;
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", onVisibility);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (pingTimer) clearInterval(pingTimer);
      if (statTimer) clearInterval(statTimer);
      conn.current?.close();
      conn.current = null;
    };
  }, [blobId, connector, canvasRef, generation]);

  return { state, stats, send, noteInput, lastInputAt, retry };
}
