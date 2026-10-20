import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import { ClientPrefsSchema } from "@kora/contracts";

import * as IpcChannels from "../channelNames.ts";
import * as ShellIpc from "../ShellIpc.ts";
import * as ShellClientPrefs from "../../prefs/ShellClientPrefs.ts";

export const getClientPrefs = ShellIpc.defineIpcMethod({
  channel: IpcChannels.IPC_GET_CLIENT_PREFS,
  payload: Schema.Void,
  result: Schema.NullOr(ClientPrefsSchema),
  handler: Effect.fn("shell.ipc.clientSettings.get")(function* () {
    const clientPrefs = yield* ShellClientPrefs.ShellClientPrefs;
    return Option.getOrNull(yield* clientPrefs.get);
  }),
});

export const setClientPrefs = ShellIpc.defineIpcMethod({
  channel: IpcChannels.IPC_SET_CLIENT_PREFS,
  payload: ClientPrefsSchema,
  result: Schema.Void,
  handler: Effect.fn("shell.ipc.clientSettings.set")(function* (conf) {
    const clientPrefs = yield* ShellClientPrefs.ShellClientPrefs;
    yield* clientPrefs.set(conf);
  }),
});
