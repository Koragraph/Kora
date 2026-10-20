import { MachinePlatform } from "@kora/shared/hostMachine";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import { listAppWindows } from "../../native/AppWindows.ts";
import * as NativeApp from "../../native/NativeApp.ts";
import { IPC_SET_NOTIFICATION_BADGE } from "../channelNames.ts";
import * as ShellIpc from "../ShellIpc.ts";

/**
 * What the renderer asks for: how many threads want attention, and the picture Windows overlays on the taskbar
 * button for it (macOS and Linux draw their own number).
 */
const PNG_DATA_URL = /^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i;
const smallPng = Schema.String.check(Schema.isMaxLength(16 * 1024), Schema.isPattern(PNG_DATA_URL));
const BadgeRequest = Schema.Struct({
  count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 ** 31 - 1 })),
  image: Schema.NullOr(smallPng),
});
type BadgeRequest = typeof BadgeRequest.Type;

/** Puts `count` on the dock icon or taskbar button. Nothing is shown while one of Kora's windows has focus. */
export function showAttentionBadge(
  platform: NodeJS.Platform,
  { count, image }: BadgeRequest,
): void {
  try {
    const shown = Electron.BrowserWindow.getFocusedWindow() ? 0 : count;
    if (platform === "darwin" || platform === "linux") {
      Electron.app.setBadgeCount(shown);
    } else if (platform === "win32") {
      const picture = shown > 0 && image ? Electron.nativeImage.createFromDataURL(image) : null;
      const overlay = picture && !picture.isEmpty() ? picture : null;
      const description = shown > 0 ? `${shown} threads with new notifications` : "";
      for (const win of Electron.BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.setOverlayIcon(overlay, description);
      }
    }
  } catch (cause) {
    // A badge is a hint; a desktop without one must not break notifications.
    Effect.runSync(Effect.logWarning("Could not update notification badge", cause));
  }
}

export const installAttentionBadge = Effect.fn("shell.ipc.installAttentionBadge")(function* () {
  const platform = yield* MachinePlatform;

  /** Clears the badge and tells each window, so its next count is sent fresh rather than deduplicated away. */
  const clear = () => {
    showAttentionBadge(platform, { count: 0, image: null });
    for (const win of listAppWindows()) win.webContents.send(IPC_SET_NOTIFICATION_BADGE);
  };

  yield* Effect.flatMap(ShellIpc.ShellIpc, (ipc) =>
    ipc.handle(
      ShellIpc.defineIpcMethod({
        channel: IPC_SET_NOTIFICATION_BADGE,
        payload: BadgeRequest,
        result: Schema.Void,
        handler: (request) =>
          Effect.sync(() =>
            request.count > 0 && Electron.BrowserWindow.getFocusedWindow()
              ? clear() // the user is looking at Kora already
              : showAttentionBadge(platform, request),
          ),
      }),
    ),
  );
  // Looking at Kora, quitting it and tearing this down all mean nobody needs the reminder.
  const app = yield* NativeApp.NativeApp;
  for (const moment of ["browser-window-focus", "before-quit"] as const)
    yield* app.on(moment, clear);
  yield* Effect.addFinalizer(() => Effect.sync(clear));
});
