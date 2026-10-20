import * as Effect from "effect/Effect";

import {
  showContextMenu,
  setTheme,
  pickFolder,
  probeRemoteEditors,
  pasteAsText,
  openExternal,
  getWindowFullscreenState,
  getSystemLocale,
  getLocalHostBearerToken,
  getLocalHostBootstraps,
  getAppBranding,
} from "./handlers/windowInfo.ts";
import * as UpdatesIpc from "./handlers/appUpdates.ts";
import * as PreviewIpc from "./handlers/webTabs.ts";
import { installAttentionBadge } from "./methods/attentionBadge.ts";
import { getLocalHostEnabled, setLocalHostEnabled } from "./methods/localHost.ts";
import { registerHtmlPreview } from "./methods/htmlPreview.ts";
import { getClientPrefs, setClientPrefs } from "./methods/clientPrefs.ts";
import * as AppActivationIpc from "./handlers/activation.ts";
import { fetchRemoteMediaIpc } from "./methods/remoteMedia.ts";
import * as ShellIpc from "./ShellIpc.ts";

export const installShellIpcHandlers = Effect.fn("shell.ipc.installHandlers")(function* () {
  const ipc = yield* ShellIpc.ShellIpc;
  yield* installAttentionBadge();
  yield* PreviewIpc.installWebEventForwarding();

  yield* ipc.handle(AppActivationIpc.setReady);
  yield* ipc.handle(AppActivationIpc.complete);

  yield* UpdatesIpc.installUpdateStateBroadcast();
  yield* ipc.handle(UpdatesIpc.getState);
  yield* ipc.handle(UpdatesIpc.check);
  yield* ipc.handle(UpdatesIpc.install);
  yield* ipc.handle(UpdatesIpc.reportBug);
  yield* ipc.handle(UpdatesIpc.revealLogs);

  yield* ipc.handleSync(getWindowFullscreenState);
  yield* ipc.handleSync(getSystemLocale);
  yield* ipc.handleSync(getAppBranding);
  yield* ipc.handleSync(getLocalHostBootstraps);
  yield* ipc.handleSync(getLocalHostEnabled);
  yield* ipc.handle(setLocalHostEnabled);
  yield* ipc.handle(getLocalHostBearerToken);

  yield* ipc.handle(getClientPrefs);
  yield* ipc.handle(setClientPrefs);

  yield* ipc.handle(openExternal);
  yield* ipc.handle(showContextMenu);
  yield* ipc.handle(setTheme);
  yield* ipc.handle(pickFolder);
  yield* ipc.handle(pasteAsText);
  yield* ipc.handle(fetchRemoteMediaIpc);
  yield* ipc.handle(probeRemoteEditors);
  yield* ipc.handle(registerHtmlPreview);
  for (const previewMethod of PreviewIpc.methods) {
    yield* ipc.handle(previewMethod);
  }
});
