// Sandboxed preload of the app window. It publishes `window.shellBridge` (typed by ShellBridge in @kora/contracts)
// and `window.koraHtmlPreview`; every member is a thin wrapper over one IPC channel from ipc/channels.ts.
import type {
  ClientPrefs,
  ShellBridge,
  ShellLaunchResponse,
  ShellTheme,
  ShellWebColorScheme,
  ShellWebMarkupTheme,
  ShellWebScreencastFrame,
  ShellWebScreenshotArtifact,
  ShellWebTabDefaults,
  ShellWebTabState,
  WebMarkupSubmissionResult,
} from "@kora/contracts";
import { contextBridge, ipcRenderer, webFrame } from "electron";

import * as Channel from "./ipc/channelNames.ts";

const invoke = <T = void>(channel: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, payload) as Promise<T>;

/** Subscribe and hand back the remover for exactly this wrapper. */
function listen(channel: string, handler: (...args: unknown[]) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => handler(...args);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

// The platform never changes after load, so it is captured once.
// oxlint-disable-next-line kora/no-global-process-runtime -- the sandboxed preload has no Effect runtime.
const platform = process.platform;

const tabCall =
  <T = void>(channel: string) =>
  (tabId: string) =>
    invoke<T>(channel, { tabId });

const preview: NonNullable<ShellBridge["preview"]> = {
  createTab: async (tabId: string, defaults?: ShellWebTabDefaults) => {
    await invoke<ShellWebTabState>(Channel.IPC_WEB_CREATE_TAB, {
      tabId,
      zoomFactor: defaults?.zoomFactor,
      colorScheme: defaults?.colorScheme,
    });
  },
  closeTab: tabCall(Channel.IPC_WEB_CLOSE_TAB),
  registerWebview: (tabId: string, webContentsId: number) =>
    invoke(Channel.IPC_WEB_REGISTER_WEBVIEW, { tabId, webContentsId }),
  navigate: (tabId: string, url: string) => invoke(Channel.IPC_WEB_NAVIGATE, { tabId, url }),
  goBack: tabCall(Channel.IPC_WEB_GO_BACK),
  goForward: tabCall(Channel.IPC_WEB_GO_FORWARD),
  refresh: tabCall(Channel.IPC_WEB_REFRESH),
  zoomIn: tabCall(Channel.IPC_WEB_ZOOM_IN),
  zoomOut: tabCall(Channel.IPC_WEB_ZOOM_OUT),
  resetZoom: tabCall(Channel.IPC_WEB_RESET_ZOOM),
  hardReload: tabCall(Channel.IPC_WEB_HARD_RELOAD),
  setColorScheme: (tabId: string, colorScheme: ShellWebColorScheme) =>
    invoke(Channel.IPC_WEB_SET_COLOR_SCHEME, { tabId, colorScheme }),
  setAudioMuted: (tabId: string, audioMuted: boolean) =>
    invoke(Channel.IPC_WEB_SET_AUDIO_MUTED, { tabId, audioMuted }),
  openDevTools: tabCall(Channel.IPC_WEB_OPEN_DEVTOOLS),
  clearCookies: (hostId: string, profileId?: string) =>
    invoke(Channel.IPC_WEB_CLEAR_COOKIES, { hostId, profileId }),
  clearCache: (hostId: string, profileId?: string) =>
    invoke(Channel.IPC_WEB_CLEAR_CACHE, { hostId, profileId }),
  getWebConfig: (hostId: string, profileId?: string) =>
    invoke(Channel.IPC_WEB_GET_CONFIG, { hostId, profileId }),
  setMarkupTheme: (theme: ShellWebMarkupTheme) =>
    invoke(Channel.IPC_WEB_SET_MARKUP_THEME, { theme }),
  pickElement: tabCall<WebMarkupSubmissionResult | null>(Channel.IPC_WEB_PICK_ELEMENT),
  cancelPickElement: tabCall(Channel.IPC_WEB_CANCEL_PICK_ELEMENT),
  captureScreenshot: tabCall<ShellWebScreenshotArtifact>(Channel.IPC_WEB_CAPTURE_SCREENSHOT),
  revealArtifact: (path: string) => invoke(Channel.IPC_WEB_REVEAL_ARTIFACT, { path }),
  copyArtifactToClipboard: (path: string) => invoke(Channel.IPC_WEB_COPY_ARTIFACT, { path }),
  pictureInPicture: {
    open: tabCall(Channel.IPC_WEB_POPOUT_OPEN),
    close: tabCall(Channel.IPC_WEB_POPOUT_CLOSE),
  },
  recording: {
    startScreencast: tabCall(Channel.IPC_WEB_SCREENCAST_START),
    stopScreencast: tabCall(Channel.IPC_WEB_SCREENCAST_STOP),
    save: (tabId: string, mimeType: string, data: Uint8Array) =>
      invoke(Channel.IPC_WEB_SCREENCAST_SAVE, { tabId, mimeType, data }),
    onFrame: (listener: (frame: ShellWebScreencastFrame) => void) =>
      listen(Channel.IPC_WEB_SCREENCAST_FRAME, (frame) => {
        if (isObject(frame)) listener(frame as ShellWebScreencastFrame);
      }),
  },
  onStateChange: (listener: (tabId: string, state: ShellWebTabState) => void) =>
    listen(Channel.IPC_WEB_STATE_CHANGE, (tabId, state) => {
      if (typeof tabId === "string" && isObject(state)) listener(tabId, state as ShellWebTabState);
    }),
  onPointerEvent: (listener) =>
    listen(Channel.IPC_WEB_POINTER_EVENT, (event) => {
      if (isObject(event)) listener(event as Parameters<typeof listener>[0]);
    }),
};

const shellBridge: ShellBridge = {
  getAppBranding: () => {
    const branding = ipcRenderer.sendSync(Channel.IPC_GET_APP_BRANDING);
    return isObject(branding) ? (branding as ReturnType<ShellBridge["getAppBranding"]>) : null;
  },
  getClientPlatform: () => platform,
  setNotificationBadge: (badge) => invoke(Channel.IPC_SET_NOTIFICATION_BADGE, badge),
  onNotificationBadgeClear: (listener: () => void) =>
    listen(Channel.IPC_SET_NOTIFICATION_BADGE, () => listener()),
  getSystemLocale: () => {
    const locale = ipcRenderer.sendSync(Channel.IPC_GET_SYSTEM_LOCALE);
    return typeof locale === "string" ? locale : null;
  },
  getLocalHostBootstraps: () => {
    const hosts = ipcRenderer.sendSync(Channel.IPC_GET_LOCAL_HOST_BOOTSTRAPS);
    return Array.isArray(hosts) ? hosts : [];
  },
  getLocalHostBearerToken: () => invoke<string>(Channel.IPC_GET_LOCAL_HOST_BEARER_TOKEN),
  getClientPrefs: () => invoke<ClientPrefs | null>(Channel.IPC_GET_CLIENT_PREFS),
  setClientPrefs: (settings: ClientPrefs) => invoke(Channel.IPC_SET_CLIENT_PREFS, settings),
  pickFolder: (options) => invoke<string | null>(Channel.IPC_PICK_FOLDER, options),
  setTheme: (theme: ShellTheme) => invoke(Channel.IPC_SET_THEME, theme),
  showContextMenu: (items, position) =>
    invoke(Channel.IPC_CONTEXT_MENU, {
      items,
      ...(position === undefined ? {} : { position }),
    }) as never,
  openExternal: (url: string) => invoke<boolean>(Channel.IPC_OPEN_EXTERNAL, url),
  probeRemoteEditors: () => invoke(Channel.IPC_PROBE_REMOTE_EDITORS) as never,
  pasteAsText: () => invoke(Channel.IPC_PASTE_AS_TEXT),
  fetchRemoteMedia: (url: string) => invoke(Channel.IPC_FETCH_REMOTE_MEDIA, url) as never,
  onMenuAction: (listener: (action: string) => void) =>
    listen(Channel.IPC_MENU_ACTION, (action) => {
      if (typeof action === "string") listener(action);
    }),
  getWindowFullscreenState: () =>
    ipcRenderer.sendSync(Channel.IPC_GET_WINDOW_FULLSCREEN_STATE) === true,
  onWindowFullscreenStateChange: (listener: (fullscreen: boolean) => void) =>
    listen(Channel.IPC_WINDOW_FULLSCREEN_STATE, (fullscreen) => {
      if (typeof fullscreen === "boolean") listener(fullscreen);
    }),
  updates: {
    getState: () => invoke(Channel.IPC_UPDATE_GET_STATE) as never,
    check: () => invoke(Channel.IPC_UPDATE_CHECK) as never,
    install: () => invoke(Channel.IPC_UPDATE_INSTALL) as never,
    onState: (listener) =>
      listen(Channel.IPC_UPDATE_STATE, (state) => {
        if (isObject(state)) listener(state as Parameters<typeof listener>[0]);
      }),
  },
  reportBug: () => invoke(Channel.IPC_REPORT_BUG),
  revealLogs: () => invoke(Channel.IPC_REVEAL_LOGS),
  appActivation: {
    setReady: (ready: boolean) => invoke(Channel.IPC_SHELL_LAUNCH_READY, ready),
    complete: (response: ShellLaunchResponse) =>
      invoke(Channel.IPC_SHELL_LAUNCH_COMPLETE, response),
    onRequest: (listener) =>
      listen(Channel.IPC_SHELL_LAUNCH_REQUEST, (request) => {
        if (isObject(request)) listener(request as Parameters<typeof listener>[0]);
      }),
  },
  preview,
};

contextBridge.exposeInMainWorld("shellBridge", shellBridge);
// Kept off ShellBridge because that type is a shared contract; the web client feature-detects it.
contextBridge.exposeInMainWorld("koraHtmlPreview", {
  register: (html: string): Promise<string> =>
    invoke<string>(Channel.IPC_HTML_PREVIEW_REGISTER, html),
});

// The macOS traffic lights keep their size under page zoom, so the gutter the page reserves for them is divided by
// the zoom factor to stay 90 points wide.
if (platform === "darwin" && typeof window !== "undefined") {
  const WINDOW_CONTROLS_INSET = 90;
  const keepControlsInset = () => {
    document.documentElement.style.setProperty(
      "--desktop-window-controls-inset",
      `${WINDOW_CONTROLS_INSET / webFrame.getZoomFactor()}px`,
    );
  };
  window.addEventListener("DOMContentLoaded", keepControlsInset);
  window.addEventListener("resize", keepControlsInset);
}
