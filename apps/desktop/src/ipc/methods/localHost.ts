import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ShellLifecycle from "../../app/ShellLifecycle.ts";
import * as ShellAppPrefs from "../../prefs/ShellAppPrefs.ts";
import * as IpcChannels from "../channelNames.ts";
import { defineIpcMethod, defineSyncIpcMethod } from "../ShellIpc.ts";

export const getLocalHostEnabled = defineSyncIpcMethod({
  channel: IpcChannels.IPC_GET_LOCAL_HOST_ENABLED,
  result: Schema.Boolean,
  handler: Effect.fn("shell.ipc.localHost.getEnabled")(function* () {
    const appPrefs = yield* ShellAppPrefs.ShellAppPrefs;
    return (yield* appPrefs.get).localHostEnabled;
  }),
});

export const setLocalHostEnabled = defineIpcMethod({
  channel: IpcChannels.IPC_SET_LOCAL_HOST_ENABLED,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("shell.ipc.localHost.setEnabled")(function* (enabled) {
    const appPrefs = yield* ShellAppPrefs.ShellAppPrefs;
    const lifecycle = yield* ShellLifecycle.ShellLifecycle;
    const change = yield* appPrefs.setLocalHostEnabled(enabled);
    if (change.changed) {
      yield* lifecycle.relaunch(`localHostEnabled=${enabled}`);
    }
  }),
});
