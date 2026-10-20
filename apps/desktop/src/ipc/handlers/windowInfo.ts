import * as Electron from "electron";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import { isCommandAvailable } from "@kora/shared/commandLookup";
import {
  ContextMenuItemSchema,
  ShellThemeSchema,
  ShellHostBootstrapSchema,
  ShellAppBrandingSchema,
  REMOTE_CAPABLE_EDITOR_IDS,
  PickFolderOptionsSchema,
  PRIMARY_LOCAL_HOST_ID,
  ExternalEditorId,
  EDITORS,
} from "@kora/contracts";

import * as Channels from "../channelNames.ts";
import { defineIpcMethod, defineSyncIpcMethod } from "../ShellIpc.ts";
import * as ShellAppPrefs from "../../prefs/ShellAppPrefs.ts";
import * as NativeWindow from "../../native/NativeWindow.ts";
import * as NativeTheme from "../../native/NativeTheme.ts";
import * as NativeShell from "../../native/NativeShell.ts";
import * as NativeMenu from "../../native/NativeMenu.ts";
import * as NativeDialog from "../../native/NativeDialog.ts";
import * as NativeApp from "../../native/NativeApp.ts";
import * as ShellKoraDaemon from "../../backend/ShellKoraDaemon.ts";
import * as ShellContext from "../../app/ShellContext.ts";

// --- values the renderer needs at first paint (synchronous) ---------------------------------------------------

export const getAppBranding = defineSyncIpcMethod({
  channel: Channels.IPC_GET_APP_BRANDING,
  result: Schema.NullOr(ShellAppBrandingSchema),
  handler: () => Effect.map(ShellContext.ShellContext, (envVars) => envVars.branding),
});

export const getSystemLocale = defineSyncIpcMethod({
  channel: Channels.IPC_GET_SYSTEM_LOCALE,
  result: Schema.String,
  handler: () => Effect.flatMap(NativeApp.NativeApp, (application) => application.systemLocale),
});

export const getWindowFullscreenState = defineSyncIpcMethod({
  channel: Channels.IPC_GET_WINDOW_FULLSCREEN_STATE,
  result: Schema.Boolean,
  handler: () =>
    Effect.gen(function* () {
      const nativeWindow = yield* NativeWindow.NativeWindow;
      const win = yield* nativeWindow.mainOrAnyWindow;
      return Option.isSome(win) && win.value.isFullScreen();
    }),
});

export const getLocalHostBootstraps = defineSyncIpcMethod({
  channel: Channels.IPC_GET_LOCAL_HOST_BOOTSTRAPS,
  result: Schema.Array(ShellHostBootstrapSchema),
  // No token here: the renderer asks for the bearer separately and mints its own websocket tickets.
  handler: () =>
    Effect.map(ShellKoraDaemon.ShellKoraDaemon, (daemon) => [
      {
        id: PRIMARY_LOCAL_HOST_ID,
        label: ShellKoraDaemon.PRIMARY_HOST_LABEL,
        httpBaseUrl: daemon.httpBaseUrl.href,
        wsBaseUrl: ShellKoraDaemon.toWebSocketBaseUrl(daemon.httpBaseUrl),
      },
    ]),
});

export const getLocalHostBearerToken = defineIpcMethod({
  channel: Channels.IPC_GET_LOCAL_HOST_BEARER_TOKEN,
  payload: Schema.Void,
  result: Schema.String,
  handler: () => Effect.flatMap(ShellKoraDaemon.ShellKoraDaemon, (daemon) => daemon.bearerToken),
});

// --- dialogs, theme, menus -------------------------------------------------------------------------------------

export const pickFolder = defineIpcMethod({
  channel: Channels.IPC_PICK_FOLDER,
  payload: Schema.UndefinedOr(PickFolderOptionsSchema),
  result: Schema.NullOr(Schema.String),
  handler: (opts) =>
    Effect.gen(function* () {
      const prefsObj = yield* (yield* ShellAppPrefs.ShellAppPrefs).get;
      // A folder only means something to a backend on this machine.
      if (!prefsObj.localHostEnabled) return null;
      const envVars = yield* ShellContext.ShellContext;
      const holder = yield* (yield* NativeWindow.NativeWindow).focusedOrMainWindow;
      const picked = yield* (yield* NativeDialog.NativeDialog).pickFolder({
        owner: holder,
        defaultPath: envVars.resolvePickFolderDefaultPath(opts),
      });
      return Option.getOrNull(picked);
    }),
});

export const setTheme = defineIpcMethod({
  channel: Channels.IPC_SET_THEME,
  payload: ShellThemeSchema,
  result: Schema.Void,
  handler: (palette) =>
    Effect.flatMap(NativeTheme.NativeTheme, (nativeTheme) => nativeTheme.setSource(palette)),
});

export const showContextMenu = defineIpcMethod({
  channel: Channels.IPC_CONTEXT_MENU,
  payload: Schema.Struct({
    items: Schema.Array(ContextMenuItemSchema),
    position: Schema.optionalKey(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
  }),
  result: Schema.NullOr(Schema.String),
  handler: ({ items, position }) =>
    Effect.gen(function* () {
      const win = yield* (yield* NativeWindow.NativeWindow).focusedOrMainWindow;
      if (Option.isNone(win)) return null;
      const chosen = yield* (yield* NativeMenu.NativeMenu).showContextMenu({
        window: win.value,
        items,
        position: Option.fromNullishOr(position),
      });
      return Option.getOrNull(chosen);
    }),
});

export const openExternal = defineIpcMethod({
  channel: Channels.IPC_OPEN_EXTERNAL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: (address) => Effect.flatMap(NativeShell.NativeShell, (sh) => sh.openExternal(address)),
});

// --- editors on this machine -----------------------------------------------------------------------------------

export const probeRemoteEditors = defineIpcMethod({
  channel: Channels.IPC_PROBE_REMOTE_EDITORS,
  payload: Schema.Undefined,
  result: Schema.Array(ExternalEditorId),
  // The renderer runs here, so this machine's PATH is the one that matters (not the server's). A Finder-launched
  // app may see a short PATH; an empty answer just makes the renderer offer VS Code only.
  handler: () =>
    Effect.gen(function* () {
      const available: Array<typeof ExternalEditorId.Type> = [];
      for (const ident of REMOTE_CAPABLE_EDITOR_IDS) {
        const ed = EDITORS.find((cand) => cand.id === ident);
        for (const cmd of ed?.commands ?? []) {
          if (yield* isCommandAvailable(cmd, { env: process.env })) {
            available.push(ident);
            break;
          }
        }
      }
      return available;
    }),
});

// --- paste as text ---------------------------------------------------------------------------------------------

export const pasteAsText = defineIpcMethod({
  channel: Channels.IPC_PASTE_AS_TEXT,
  payload: Schema.Undefined,
  result: Schema.Void,
  // Only the main window's own renderer may trigger this, and only for contents that belong to that window (its
  // focused <webview> guest included); plain-text paste goes to whichever of them has focus.
  handler: (_payload, evt) =>
    Effect.gen(function* () {
      const main = yield* (yield* NativeWindow.NativeWindow).main;
      if (Option.isNone(main) || main.value.isDestroyed()) return;
      if (evt?.sender.id !== main.value.webContents.id) return;
      const focused = Electron.webContents.getFocusedWebContents();
      if (!focused || focused.isDestroyed()) return;
      if (Electron.BrowserWindow.fromWebContents(focused) !== main.value) return;
      focused.paste();
    }),
});
