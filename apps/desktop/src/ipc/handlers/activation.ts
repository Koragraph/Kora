import { ShellLaunchResponse } from "@kora/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ShellLaunch from "../../app/ShellLaunch.ts";
import * as IpcChannels from "../channelNames.ts";
import * as ShellIpc from "../ShellIpc.ts";

export const setReady = ShellIpc.defineIpcMethod({
  channel: IpcChannels.IPC_SHELL_LAUNCH_READY,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("shell.ipc.appActivation.setReady")(function* (ready) {
    const activation = yield* ShellLaunch.ShellLaunch;
    yield* activation.setRendererReady(ready);
  }),
});

export const complete = ShellIpc.defineIpcMethod({
  channel: IpcChannels.IPC_SHELL_LAUNCH_COMPLETE,
  payload: ShellLaunchResponse,
  result: Schema.Void,
  handler: Effect.fn("shell.ipc.appActivation.complete")(function* (response) {
    const activation = yield* ShellLaunch.ShellLaunch;
    yield* activation.complete(response);
  }),
});
