import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  WebMarkupSubmissionResultSchema,
  ShellWebviewConfigSchema,
  ShellWebTabInputSchema,
  ShellWebSetColorSchemeInputSchema,
  ShellWebSetAudioMutedInputSchema,
  ShellWebScreenshotArtifactSchema,
  ShellWebScreencastSaveInputSchema,
  ShellWebScreencastArtifactSchema,
  ShellWebRegisterWebviewInputSchema,
  ShellWebNavigateInputSchema,
  ShellWebMarkupThemeInputSchema,
  ShellWebCreateTabInputSchema,
  ShellWebConfigInputSchema,
  ShellWebClearDataInputSchema,
  ShellWebArtifactInputSchema,
  PRIVATE_WEB_PROFILE_ID,
  DEFAULT_WEB_PROFILE_ID,
} from "@kora/contracts";

import * as Channels from "../channelNames.ts";
import { defineIpcMethod } from "../ShellIpc.ts";
import { WEBVIEW_PREFERENCES } from "../../web/WebviewPreferences.ts";
import * as WebManager from "../../web/Manager.ts";
import * as NativeWindow from "../../native/NativeWindow.ts";
import * as ShellContext from "../../app/ShellContext.ts";

/** Hand the manager's three event streams to every app window. */
export const installWebEventForwarding = Effect.fn("shell.ipc.preview.installEventForwarding")(
  function* () {
    const mgr = yield* WebManager.WebManager;
    const nativeWindow = yield* NativeWindow.NativeWindow;
    yield* mgr.subscribeStateChanges((tabKey, snap) =>
      nativeWindow.sendAll(Channels.IPC_WEB_STATE_CHANGE, tabKey, snap),
    );
    yield* mgr.subscribeRecordingFrames((fr) =>
      nativeWindow.sendAll(Channels.IPC_WEB_SCREENCAST_FRAME, fr),
    );
    yield* mgr.subscribePointerEvents((evt) =>
      nativeWindow.sendAll(Channels.IPC_WEB_POINTER_EVENT, evt),
    );
  },
);

/**
 * The session partition behind a (host, profile) pair. The default profile keeps the bare host id so logins made
 * before profiles existed stay put. Any other profile gets a JSON array of the two ids: unlike URI encoding it
 * cannot throw on a lone surrogate, and unlike U+FFFD replacement it cannot make two ids collide.
 */
export function resolvePartitionScope(
  hostKey: string,
  profileId: string | undefined,
): { scope: string; persistent: boolean; namespace?: "profile" } {
  if (profileId === undefined || profileId === DEFAULT_WEB_PROFILE_ID) {
    return { scope: hostKey, persistent: true };
  }
  return {
    scope: JSON.stringify([hostKey, profileId]),
    persistent: profileId !== PRIVATE_WEB_PROFILE_ID,
    namespace: "profile",
  };
}

// A method that takes a tab id and calls the manager method of the given name.
type TabAction =
  | "closeTab"
  | "goBack"
  | "goForward"
  | "refresh"
  | "zoomIn"
  | "zoomOut"
  | "resetZoom"
  | "hardReload"
  | "openDevTools"
  | "cancelPickElement"
  | "beginScreencast"
  | "endScreencast"
  | "openPopout"
  | "closePopout";

const tabMethod = (chan: string, actionName: TabAction) =>
  defineIpcMethod({
    channel: chan,
    payload: ShellWebTabInputSchema,
    result: Schema.Void,
    handler: ({ tabId }) => Effect.flatMap(WebManager.WebManager, (mgr) => mgr[actionName](tabId)),
  });

export const createTab = defineIpcMethod({
  channel: Channels.IPC_WEB_CREATE_TAB,
  payload: ShellWebCreateTabInputSchema,
  result: Schema.Void,
  handler: ({ tabId, zoomFactor, colorScheme }) =>
    Effect.flatMap(WebManager.WebManager, (mgr) =>
      mgr.createTab(tabId, {
        ...(zoomFactor === undefined ? {} : { zoomFactor }),
        ...(colorScheme === undefined ? {} : { colorScheme }),
      }),
    ).pipe(Effect.asVoid),
});

export const closeTab = tabMethod(Channels.IPC_WEB_CLOSE_TAB, "closeTab");

export const registerWebview = defineIpcMethod({
  channel: Channels.IPC_WEB_REGISTER_WEBVIEW,
  payload: ShellWebRegisterWebviewInputSchema,
  result: Schema.Void,
  handler: ({ tabId, webContentsId }) =>
    Effect.flatMap(WebManager.WebManager, (mgr) => mgr.registerWebview(tabId, webContentsId)),
});

export const navigate = defineIpcMethod({
  channel: Channels.IPC_WEB_NAVIGATE,
  payload: ShellWebNavigateInputSchema,
  result: Schema.Void,
  handler: ({ tabId, url }) =>
    Effect.flatMap(WebManager.WebManager, (mgr) => mgr.navigate(tabId, url)),
});

export const goBack = tabMethod(Channels.IPC_WEB_GO_BACK, "goBack");
export const goForward = tabMethod(Channels.IPC_WEB_GO_FORWARD, "goForward");
export const refresh = tabMethod(Channels.IPC_WEB_REFRESH, "refresh");
export const zoomIn = tabMethod(Channels.IPC_WEB_ZOOM_IN, "zoomIn");
export const zoomOut = tabMethod(Channels.IPC_WEB_ZOOM_OUT, "zoomOut");
export const resetZoom = tabMethod(Channels.IPC_WEB_RESET_ZOOM, "resetZoom");
export const hardReload = tabMethod(Channels.IPC_WEB_HARD_RELOAD, "hardReload");

export const setColorScheme = defineIpcMethod({
  channel: Channels.IPC_WEB_SET_COLOR_SCHEME,
  payload: ShellWebSetColorSchemeInputSchema,
  result: Schema.Void,
  handler: ({ tabId, colorScheme }) =>
    Effect.flatMap(WebManager.WebManager, (mgr) => mgr.setColorScheme(tabId, colorScheme)),
});

export const setAudioMuted = defineIpcMethod({
  channel: Channels.IPC_WEB_SET_AUDIO_MUTED,
  payload: ShellWebSetAudioMutedInputSchema,
  result: Schema.Void,
  handler: ({ tabId, audioMuted }) =>
    Effect.flatMap(WebManager.WebManager, (mgr) => mgr.setAudioMuted(tabId, audioMuted)),
});

export const openDevTools = tabMethod(Channels.IPC_WEB_OPEN_DEVTOOLS, "openDevTools");
export const cancelPickElement = tabMethod(
  Channels.IPC_WEB_CANCEL_PICK_ELEMENT,
  "cancelPickElement",
);
export const beginScreencast = tabMethod(Channels.IPC_WEB_SCREENCAST_START, "beginScreencast");
export const endScreencast = tabMethod(Channels.IPC_WEB_SCREENCAST_STOP, "endScreencast");
export const openPopout = tabMethod(Channels.IPC_WEB_POPOUT_OPEN, "openPopout");
export const closePopout = tabMethod(Channels.IPC_WEB_POPOUT_CLOSE, "closePopout");

// Clearing only reaches sessions the manager already holds, so a profile that no tab has opened this run must be
// loaded first or "clear" would report success and delete nothing.
const clearMethod = (chan: string, actionName: "clearCookies" | "clearCache") =>
  defineIpcMethod({
    channel: chan,
    payload: ShellWebClearDataInputSchema,
    result: Schema.Void,
    handler: ({ hostId, profileId }) =>
      Effect.gen(function* () {
        const mgr = yield* WebManager.WebManager;
        if (profileId === undefined) return yield* mgr[actionName](undefined);
        const { scope, persistent, namespace } = resolvePartitionScope(hostId, profileId);
        yield* mgr.getBrowserSession(scope, persistent, namespace);
        const partName = yield* mgr.getBrowserPartition(scope, persistent, namespace);
        yield* mgr[actionName]([partName]);
      }),
  });

export const clearCookies = clearMethod(Channels.IPC_WEB_CLEAR_COOKIES, "clearCookies");
export const clearCache = clearMethod(Channels.IPC_WEB_CLEAR_CACHE, "clearCache");

export const getWebConfig = defineIpcMethod({
  channel: Channels.IPC_WEB_GET_CONFIG,
  payload: ShellWebConfigInputSchema,
  result: ShellWebviewConfigSchema,
  handler: ({ hostId, profileId }) =>
    Effect.gen(function* () {
      const mgr = yield* WebManager.WebManager;
      const envVars = yield* ShellContext.ShellContext;
      const { scope, persistent, namespace } = resolvePartitionScope(hostId, profileId);
      // Loading the session installs the permission handlers; a guest attached to an untouched partition would
      // otherwise run with Electron's defaults.
      yield* mgr.getBrowserSession(scope, persistent, namespace);
      return {
        partition: yield* mgr.getBrowserPartition(scope, persistent, namespace),
        webPreferences: WEBVIEW_PREFERENCES,
        preloadUrl: NodeURL.pathToFileURL(
          envVars.path.join(envVars.dirname, "web-pick-preload.cjs"),
        ).href,
      };
    }),
});

export const setMarkupTheme = defineIpcMethod({
  channel: Channels.IPC_WEB_SET_MARKUP_THEME,
  payload: ShellWebMarkupThemeInputSchema,
  result: Schema.Void,
  handler: ({ theme }) => Effect.flatMap(WebManager.WebManager, (mgr) => mgr.setMarkupTheme(theme)),
});

export const pickElement = defineIpcMethod({
  channel: Channels.IPC_WEB_PICK_ELEMENT,
  payload: ShellWebTabInputSchema,
  result: Schema.NullOr(WebMarkupSubmissionResultSchema),
  handler: ({ tabId }) => Effect.flatMap(WebManager.WebManager, (mgr) => mgr.pickElement(tabId)),
});

export const captureScreenshot = defineIpcMethod({
  channel: Channels.IPC_WEB_CAPTURE_SCREENSHOT,
  payload: ShellWebTabInputSchema,
  result: ShellWebScreenshotArtifactSchema,
  handler: ({ tabId }) =>
    Effect.flatMap(WebManager.WebManager, (mgr) => mgr.captureScreenshot(tabId)),
});

export const revealArtifact = defineIpcMethod({
  channel: Channels.IPC_WEB_REVEAL_ARTIFACT,
  payload: ShellWebArtifactInputSchema,
  result: Schema.Void,
  handler: ({ path }) => Effect.flatMap(WebManager.WebManager, (mgr) => mgr.revealArtifact(path)),
});

export const copyArtifactToClipboard = defineIpcMethod({
  channel: Channels.IPC_WEB_COPY_ARTIFACT,
  payload: ShellWebArtifactInputSchema,
  result: Schema.Void,
  handler: ({ path }) =>
    Effect.flatMap(WebManager.WebManager, (mgr) => mgr.copyArtifactToClipboard(path)),
});

export const saveScreencast = defineIpcMethod({
  channel: Channels.IPC_WEB_SCREENCAST_SAVE,
  payload: ShellWebScreencastSaveInputSchema,
  result: ShellWebScreencastArtifactSchema,
  handler: ({ tabId, mimeType, data }) =>
    Effect.flatMap(WebManager.WebManager, (mgr) => mgr.saveScreencast(tabId, mimeType, data)),
});

export const methods = [
  saveScreencast,
  endScreencast,
  beginScreencast,
  closePopout,
  openPopout,
  copyArtifactToClipboard,
  revealArtifact,
  captureScreenshot,
  cancelPickElement,
  pickElement,
  setMarkupTheme,
  getWebConfig,
  clearCache,
  clearCookies,
  openDevTools,
  setAudioMuted,
  setColorScheme,
  hardReload,
  resetZoom,
  zoomOut,
  zoomIn,
  refresh,
  goForward,
  goBack,
  navigate,
  registerWebview,
  closeTab,
  createTab,
] as const;
