// The panel's socket to the daemon: `/blob-browser/:blobId/live` (frames out as binary JPEG, JSON both ways). Browsers
// cannot put headers on a WebSocket, so the connection is authorised with a single-use ticket from the authed
// `POST /api/auth/websocket-ticket` (the same mechanism the chat's own /ws uses) - the primary host's bearer never goes
// into a URL. Components get the connector through a context so tests and the scratch renderer pass a fake.
//
// What the connection needs from whatever sits between the page and the daemon (the packaged app, the Vite dev proxy, and any
// third-party proxy someone builds the same way, e.g. a QA harness):
//   1. `POST /api/auth/websocket-ticket` with the normal bearer (desktop: sent by the shell after the identity check; browser/dev:
//      the proxy injects it, apps/web/vite/devProxyAuth.ts). It answers `{ticket}`; the ticket is single-use and short-lived.
//   2. The upgrade `GET /blob-browser/:blobId/live?wsTicket=<ticket>` must reach the daemon AS A WEBSOCKET UPGRADE: forward
//      `Upgrade` / `Connection` (the Vite proxy needs `ws: true` for the `/blob-browser` prefix) and KEEP THE QUERY STRING. A
//      proxy that forwards only `/ws` and `/api` leaves this socket on "Connecting" for ever.
//   3. The `Origin` must be one the daemon allows (kora://, the app's own localhost origin, or the proxy's host in dev); a
//      foreign Origin is refused with 403 and shows here as "Couldn't connect".
// The engine's status and its one-time install do NOT need this socket: `useBrowserEngine` asks plain HTTP (`/api/blob-browser/engine`),
// so the setup screen shows even when the socket never opens. After 3 failed attempts the panel says "Couldn't connect" with Retry.
import { createContext, createElement, useContext, type ReactNode } from "react";

import { fetchPrimaryHost } from "~/hosts/primary/shellAuth";
import { resolvePrimaryHostHttpUrl } from "~/hosts/primary/target";

export interface LiveHandlers {
  onOpen(): void;
  onText(raw: string): void;
  onFrame(jpeg: ArrayBuffer): void;
  onClose(info: { code: number; wasOpen: boolean }): void;
}
export interface LiveConnection {
  send(raw: string): void;
  close(): void;
  readonly isOpen: boolean;
}
export type LiveConnector = (blobId: string, handlers: LiveHandlers) => LiveConnection;

/** A socket that has not opened by then is given up on (a proxy that swallows the upgrade never says no): the panel retries, then offers Retry. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** The real connector: ticket, then WebSocket. Fails closed (onClose with wasOpen=false) on any problem. */
export const connectLive: LiveConnector = (blobId, h) => {
  let ws: WebSocket | null = null;
  let closed = false;
  let opened = false;
  const giveUp = setTimeout(() => {
    if (opened || closed) return;
    closed = true;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    h.onClose({ code: 1006, wasOpen: false });
  }, CONNECT_TIMEOUT_MS);
  void (async () => {
    try {
      const res = await fetchPrimaryHost(resolvePrimaryHostHttpUrl("/api/auth/websocket-ticket"), {
        method: "POST",
      });
      if (!res.ok) throw new Error(`ticket ${res.status}`);
      const { ticket } = (await res.json()) as { ticket?: string };
      if (!ticket) throw new Error("no ticket");
      if (closed) return;
      const url = new URL(
        resolvePrimaryHostHttpUrl(`/blob-browser/${encodeURIComponent(blobId)}/live`, {
          wsTicket: ticket,
        }),
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const sock = (ws = new WebSocket(url));
      sock.binaryType = "arraybuffer";
      sock.onopen = () => {
        opened = true;
        clearTimeout(giveUp);
        h.onOpen();
      };
      sock.onmessage = (e) => {
        if (typeof e.data === "string") h.onText(e.data);
        else h.onFrame(e.data as ArrayBuffer);
      };
      sock.onclose = (e) => {
        clearTimeout(giveUp);
        if (!closed) h.onClose({ code: e.code, wasOpen: opened });
        closed = true;
      };
      sock.onerror = () => {
        /* onclose follows */
      };
    } catch {
      clearTimeout(giveUp);
      if (!closed) {
        closed = true;
        h.onClose({ code: 1006, wasOpen: false });
      }
    }
  })();
  return {
    send: (raw) => {
      if (ws && ws.readyState === 1) ws.send(raw);
    },
    close: () => {
      closed = true;
      clearTimeout(giveUp);
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
    },
    get isOpen() {
      return !!ws && ws.readyState === 1;
    },
  };
};

const LiveConnectorContext = createContext<LiveConnector>(connectLive);
export function LiveConnectorProvider(props: {
  readonly connector: LiveConnector;
  readonly children: ReactNode;
}) {
  return createElement(LiveConnectorContext.Provider, { value: props.connector }, props.children);
}
export const useLiveConnector = (): LiveConnector => useContext(LiveConnectorContext);
