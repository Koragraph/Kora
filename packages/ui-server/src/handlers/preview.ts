// @effect-diagnostics globalDate:off -- plain timestamps for wire payloads and logs, produced outside any Effect fiber.
import { RPC_METHODS } from "@kora/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { type HandlerRecord, jsonSafe } from "./shared.ts";

/**
 * Preview and preview-automation RPCs. The UI server has no embedded Chromium preview, so every
 * method returns a schema-valid response that matches "nothing is here":
 *
 * - `preview.list` returns an EMPTY collection; open/resize return a benign, valid snapshot
 *   (never a lying spinner and never a torn connection), since the error channels carry no
 *   "unsupported" tag and an empty snapshot is coherent.
 * - ack-style mutations (`preview.close`/`reportStatus`, `previewAutomation.respond`/`.focusHost`)
 *   resolve with `Effect.void`.
 * - `previewAutomation.connect` holds open forever — a stream that completes or fails tears the
 *   whole WS connection down.
 *
 * WIRE HAZARD: the JSON codec dies on nested `undefined`, so every dynamic value is run through
 * `jsonSafe` and optional keys are omitted (never set to `undefined`); `null` is used only where
 * the schema is `Schema.NullOr`.
 */

const now = (): string => new Date().toISOString();

/** Stable per-process epoch so preview-list revision resets stay coherent. */
const DAEMON_EPOCH = "kora-ui-server";

/** A preview tab only ever starts on a web page: an agent-supplied `file:`, `javascript:` or OS-handler url opens blank.
 *  A bare `localhost:3000` (no scheme) is read as http. */
export function webPreviewUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || url.trim() === "") return undefined;
  const raw = url.trim();
  // `scheme:` that is not `host:port` → keep as typed (and refuse it below unless it is http/https).
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^:/]+:\d+(?:[/?#]|$)/.test(raw);
  const withScheme = hasScheme ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export const webHandlers: HandlerRecord = {
  // ── Preview ─────────────────────────────────────────────────────────────
  // The desktop's <webview> does the browsing; this only names the tab. A url comes back as
  // Loading so the client navigates the new tab to it (an Idle snapshot opened a blank tab and
  // dropped the link). Viewport/profile are echoed so the tab is born with the asked-for ones.
  [RPC_METHODS.browserOpen]: (input) => {
    const i = input as { threadId: string; url?: string; viewport?: unknown; profileId?: string };
    const url = webPreviewUrl(i.url);
    return Effect.succeed(
      jsonSafe({
        threadId: i.threadId,
        tabId: `preview-${Date.now()}`,
        navStatus: url ? { _tag: "Loading" as const, url, title: url } : { _tag: "Idle" as const },
        canGoBack: false,
        canGoForward: false,
        ...(i.viewport !== undefined ? { viewport: i.viewport } : {}),
        ...(i.profileId !== undefined ? { profileId: i.profileId } : {}),
        updatedAt: now(),
      }),
    );
  },
  // BENIGN snapshot echoing the requested viewport.
  [RPC_METHODS.browserResize]: (input) => {
    const i = input as { threadId: string; tabId: string; viewport: unknown };
    return Effect.succeed(
      jsonSafe({
        threadId: i.threadId,
        tabId: i.tabId,
        navStatus: { _tag: "Idle" as const },
        canGoBack: false,
        canGoForward: false,
        viewport: i.viewport,
        updatedAt: now(),
      }),
    );
  },
  // ACK: void success.
  [RPC_METHODS.browserClose]: () => Effect.void,
  [RPC_METHODS.browserReportStatus]: () => Effect.void,
  // BENIGN-EMPTY: no preview sessions tracked.
  [RPC_METHODS.browserWatch]: () => Stream.never,
  [RPC_METHODS.browserList]: () =>
    Effect.succeed(jsonSafe({ sessions: [], serverEpoch: DAEMON_EPOCH, revision: 0 })),
};
