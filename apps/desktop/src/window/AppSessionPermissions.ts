import type * as Electron from "electron";
import * as Option from "effect/Option";

import { parseSafeExternalUrl } from "../native/NativeShell.ts";

/**
 * Permission policy for the app window's session (Electron's default session:
 * the main window, the connecting splash and the picture-in-picture window).
 *
 * Without handlers Electron grants EVERY permission request — camera,
 * microphone, geolocation, notifications and `openExternal`, which launches an
 * arbitrary OS protocol handler (`smb:`, `ms-msdt:`, `search-ms:`, …) — to any
 * frame in that session. That includes third-party frames the app renders:
 * agent-written HTML in the sandboxed `srcdoc` output preview and remote
 * `http(s)` iframes the renderer CSP's `frame-src` admits.
 *
 * Only the app's own origin (`kora://app` / `kora-dev://app`, including its
 * `blob:` documents) keeps the permissions it uses (`APP_ORIGIN_PERMISSIONS`); and even the app may only
 * hand `openExternal` the URLs `shell:open-external` would open itself.
 * Preview `<webview>` guests are unaffected: they live in their own partition
 * sessions with their own policy (see `WebTabPolicy.ts`).
 */

const SHELL_APP_PROTOCOLS = new Set(["kora:", "kora-dev:"]);
const SHELL_APP_HOST = "app";

export function isShellAppOrigin(urlText: string | null | undefined): boolean {
  if (typeof urlText !== "string" || urlText.length === 0) return false;
  try {
    let address = new URL(urlText);
    // A blob: URL carries its creator's origin in its path (`blob:kora://app/<uuid>`).
    if (address.protocol === "blob:") address = new URL(address.pathname);
    return (
      SHELL_APP_PROTOCOLS.has(address.protocol) &&
      address.host === SHELL_APP_HOST &&
      address.username === "" &&
      address.password === ""
    );
  } catch {
    return false;
  }
}

export interface AppPermissionDecisionInput {
  readonly permission: string;
  /** URL (or serialized origin) of the frame asking. */
  readonly requestingUrl: string | null | undefined;
  /** Only for `openExternal`: the URL the frame wants handed to the OS. */
  readonly externalUrl?: string | null | undefined;
}

/**
 * What the app's own renderer actually uses (round 2: an allowlist, not "the app
 * gets everything"): clipboard copy/paste buttons, thread/swarm notifications,
 * the font picker (`queryLocalFonts`), tab recording (`getDisplayMedia`, which
 * Chromium checks as `display-capture` / `media`), video fullscreen, and
 * `openExternal` for safe URLs. Not camera/mic (`media` from getUserMedia is
 * also blocked at the OS level: the app has no camera/mic entitlement),
 * geolocation, MIDI, HID/serial/USB, pointer/keyboard lock or anything else.
 */
const APP_ORIGIN_PERMISSIONS: ReadonlySet<string> = new Set([
  "notifications",
  "clipboard-sanitized-write",
  "clipboard-read",
  "local-fonts",
  "display-capture",
  "media",
  "fullscreen",
  "openExternal",
]);

export function decideAppSessionPermission(request: AppPermissionDecisionInput): boolean {
  if (!isShellAppOrigin(request.requestingUrl)) return false;
  if (!APP_ORIGIN_PERMISSIONS.has(request.permission)) return false;
  if (request.permission === "openExternal") {
    return Option.isSome(parseSafeExternalUrl(request.externalUrl));
  }
  return true;
}

const firstNonEmpty = (...values: ReadonlyArray<string | null | undefined>): string | undefined =>
  values.find((val): val is string => typeof val === "string" && val.length > 0);

const installedSessions = new WeakSet<object>();

/** Idempotent per session. */
export function installAppSessionPermissionPolicy(
  sess: Pick<Electron.Session, "setPermissionRequestHandler" | "setPermissionCheckHandler">,
): void {
  if (installedSessions.has(sess)) return;
  installedSessions.add(sess);
  sess.setPermissionRequestHandler((webContents, permission, callback, detailInfo) => {
    const externalUrl =
      "externalURL" in detailInfo && typeof detailInfo.externalURL === "string"
        ? detailInfo.externalURL
        : undefined;
    callback(
      decideAppSessionPermission({
        permission,
        requestingUrl: firstNonEmpty(detailInfo.requestingUrl, webContents?.getURL()),
        externalUrl,
      }),
    );
  });
  sess.setPermissionCheckHandler((webContents, permission, requestingOrigin, detailInfo) =>
    decideAppSessionPermission({
      permission,
      requestingUrl: firstNonEmpty(
        detailInfo?.requestingUrl,
        requestingOrigin,
        webContents?.getURL(),
      ),
    }),
  );
}
