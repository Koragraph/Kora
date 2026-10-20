import {
  ShellUpdateActionResultSchema,
  ShellUpdateCheckResultSchema,
  ShellUpdateStateSchema,
} from "@kora/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ShellSupport from "../../app/ShellSupport.ts";
import * as ShellUpdater from "../../app/ShellUpdater.ts";
import { listAppWindows } from "../../native/AppWindows.ts";
import * as IpcChannels from "../channelNames.ts";
import * as ShellIpc from "../ShellIpc.ts";

export const getState = ShellIpc.defineIpcMethod({
  channel: IpcChannels.IPC_UPDATE_GET_STATE,
  payload: Schema.Undefined,
  result: ShellUpdateStateSchema,
  handler: Effect.fn("shell.ipc.updates.getState")(function* () {
    const updater = yield* ShellUpdater.ShellUpdater;
    return yield* updater.state;
  }),
});

export const check = ShellIpc.defineIpcMethod({
  channel: IpcChannels.IPC_UPDATE_CHECK,
  payload: Schema.Undefined,
  result: ShellUpdateCheckResultSchema,
  handler: Effect.fn("shell.ipc.updates.check")(function* () {
    const updater = yield* ShellUpdater.ShellUpdater;
    return yield* updater.check;
  }),
});

export const install = ShellIpc.defineIpcMethod({
  channel: IpcChannels.IPC_UPDATE_INSTALL,
  payload: Schema.Undefined,
  result: ShellUpdateActionResultSchema,
  handler: Effect.fn("shell.ipc.updates.install")(function* () {
    const updater = yield* ShellUpdater.ShellUpdater;
    return yield* updater.install;
  }),
});

export const reportBug = ShellIpc.defineIpcMethod({
  channel: IpcChannels.IPC_REPORT_BUG,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: () => ShellSupport.reportBug,
});

export const revealLogs = ShellIpc.defineIpcMethod({
  channel: IpcChannels.IPC_REVEAL_LOGS,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: () => ShellSupport.revealLogs,
});

/** Push every update-state change to the app's windows (the renderer also asks once on mount). */
export const installUpdateStateBroadcast = Effect.fn("shell.ipc.updates.installBroadcast")(
  function* () {
    const updater = yield* ShellUpdater.ShellUpdater;
    yield* updater.subscribe((state) => {
      // App windows only: never a guest's OAuth popup (see AppWindows.ts).
      for (const window of listAppWindows()) {
        window.webContents.send(IpcChannels.IPC_UPDATE_STATE, state);
      }
    });
  },
);
