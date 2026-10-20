import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

// Everything here is written against injected structural types so the module never imports Electron itself.

export interface ShellIpcSenderFrame {
  readonly url: string;
  /** Null or absent for a top-level frame. */
  readonly parent?: unknown;
}

export interface ShellIpcSenderContents {
  readonly getType?: () => string;
}

export interface ShellIpcInvokeEvent {
  readonly sender: { readonly id: number } & ShellIpcSenderContents;
  readonly senderFrame?: ShellIpcSenderFrame | null;
}

export interface ShellIpcSyncEvent {
  returnValue: unknown;
  sender?: ShellIpcSenderContents;
  senderFrame?: ShellIpcSenderFrame | null;
}

export type ShellIpcSenderGate = (evt: {
  readonly sender?: ShellIpcSenderContents;
  readonly senderFrame?: ShellIpcSenderFrame | null;
}) => boolean;

export type ShellIpcHandleListener = (
  evt: ShellIpcInvokeEvent,
  unparsed: unknown,
) => unknown | Promise<unknown>;
export type ShellIpcSyncListener = (evt: ShellIpcSyncEvent) => void;

export interface ShellIpcMain {
  removeHandler(chan: string): void;
  handle(chan: string, subscriber: ShellIpcHandleListener): void;
  removeAllListeners(chan: string): void;
  on(chan: string, subscriber: ShellIpcSyncListener): void;
}

const handlerKinds = Schema.Literals(["invoke", "sync"]);

export class ShellIpcRegistrationError extends Schema.TaggedError<ShellIpcRegistrationError>()(
  "ShellIpcRegistrationError",
  { handlerKind: handlerKinds, channel: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Failed to register the ${this.handlerKind} IPC handler for ${this.channel}.`;
  }
}

export class ShellIpcUnregistrationError extends Schema.TaggedError<ShellIpcUnregistrationError>()(
  "ShellIpcUnregistrationError",
  { handlerKind: handlerKinds, channel: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Failed to unregister the ${this.handlerKind} IPC handler for ${this.channel}.`;
  }
}

export const ShellIpcError = Schema.Union([ShellIpcRegistrationError, ShellIpcUnregistrationError]);
export type ShellIpcError = typeof ShellIpcError.Type;

export interface ShellIpcMethod<Err, Env> {
  readonly channel: string;
  readonly handler: (
    unparsed: unknown,
    evt?: ShellIpcInvokeEvent,
  ) => Effect.Effect<unknown, Err, Env>;
}

export interface ShellSyncIpcMethod<Err, Env> {
  readonly channel: string;
  readonly handler: () => Effect.Effect<unknown, Err, Env>;
}

export class ShellIpc extends Context.Service<
  ShellIpc,
  {
    readonly handle: <Err, Env>(
      verb: ShellIpcMethod<Err, Env>,
    ) => Effect.Effect<void, ShellIpcRegistrationError, Env | Scope.Scope>;
    readonly handleSync: <Err, Env>(
      verb: ShellSyncIpcMethod<Err, Env>,
    ) => Effect.Effect<void, ShellIpcRegistrationError, Env | Scope.Scope>;
  }
>()("@kora/desktop/ipc/ShellIpc") {}

/**
 * Only the app's own top-level window may call the shell. ipcMain channels are process-wide, so a preview guest
 * (which runs arbitrary pages, and whose error page can even claim the app URL) could otherwise reach them.
 */
export function isShellAppFrame(evt: {
  readonly sender?: ShellIpcSenderContents;
  readonly senderFrame?: ShellIpcSenderFrame | null;
}): boolean {
  try {
    const fr = evt.senderFrame;
    if (!fr) return false;
    if (fr.parent !== null && fr.parent !== undefined) return false;
    const typ = evt.sender?.getType?.();
    if (typ !== undefined && typ !== "window") return false;
    const address = new URL(fr.url);
    return (
      (address.protocol === "kora:" || address.protocol === "kora-dev:") &&
      address.host === "app" &&
      address.username === "" &&
      address.password === ""
    );
  } catch {
    // A disposed frame throws when read; treat that as untrusted.
    return false;
  }
}

export function make(
  ipcMain: ShellIpcMain,
  isTrustedSender: ShellIpcSenderGate = () => true,
): ShellIpc["Service"] {
  // One acquire/release pair per channel: install on acquire, uninstall on release.
  const bindChannel = (
    kind: typeof handlerKinds.Type,
    channel: string,
    install: () => void,
    uninstall: () => void,
  ) =>
    Effect.acquireRelease(
      Effect.try({
        try: install,
        catch: (reason) =>
          new ShellIpcRegistrationError({ handlerKind: kind, channel, cause: reason }),
      }),
      () =>
        Effect.try({
          try: uninstall,
          catch: (reason) =>
            new ShellIpcUnregistrationError({ handlerKind: kind, channel, cause: reason }),
        }).pipe(Effect.orDie),
    );

  return ShellIpc.of({
    handle: <Err, Env>(verb: ShellIpcMethod<Err, Env>) =>
      Effect.gen(function* () {
        const run = Effect.runPromiseWith(yield* Effect.context<Env>());
        const { channel } = verb;
        yield* bindChannel(
          "invoke",
          channel,
          () => {
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, (evt, unparsed) => {
              if (!isTrustedSender(evt)) {
                return Promise.reject(new Error(`IPC ${channel} refused: untrusted sender`));
              }
              const program = verb
                .handler(unparsed, evt)
                .pipe(
                  Effect.withSpan("shell.ipc.invoke"),
                  Effect.annotateLogs({ channel }),
                  Effect.annotateSpans({ channel }),
                );
              return run(program);
            });
          },
          () => ipcMain.removeHandler(channel),
        );
      }),

    handleSync: <Err, Env>(verb: ShellSyncIpcMethod<Err, Env>) =>
      Effect.gen(function* () {
        const runSync = Effect.runSyncWith(yield* Effect.context<Env>());
        const { channel } = verb;
        yield* bindChannel(
          "sync",
          channel,
          () => {
            ipcMain.removeAllListeners(channel);
            ipcMain.on(channel, (evt) => {
              if (!isTrustedSender(evt)) {
                evt.returnValue = null;
                return;
              }
              const program = verb
                .handler()
                .pipe(
                  Effect.withSpan("shell.ipc.invokeSync"),
                  Effect.annotateLogs({ channel }),
                  Effect.annotateSpans({ channel }),
                );
              evt.returnValue = runSync(program);
            });
          },
          () => ipcMain.removeAllListeners(channel),
        );
      }),
  });
}

export const layer = (ipcMain: ShellIpcMain, isTrustedSender?: ShellIpcSenderGate) =>
  Layer.succeed(ShellIpc, make(ipcMain, isTrustedSender));

export interface ShellIpcMethodRegistration<
  In,
  InWire,
  Out,
  OutWire,
  Err,
  Env,
  InDecode = never,
  InEncode = never,
  OutDecode = never,
  OutEncode = never,
> {
  readonly handler: (input: In, evt?: ShellIpcInvokeEvent) => Effect.Effect<Out, Err, Env>;
  readonly result: Schema.Codec<Out, OutWire, OutDecode, OutEncode>;
  readonly payload: Schema.Codec<In, InWire, InDecode, InEncode>;
  readonly channel: string;
}

export interface ShellSyncIpcMethodRegistration<
  Out,
  OutWire,
  Err,
  Env,
  OutDecode = never,
  OutEncode = never,
> {
  readonly handler: () => Effect.Effect<Out, Err, Env>;
  readonly result: Schema.Codec<Out, OutWire, OutDecode, OutEncode>;
  readonly channel: string;
}

export const defineIpcMethod = <
  In,
  InWire,
  Out,
  OutWire,
  Err,
  Env,
  InDecode = never,
  InEncode = never,
  OutDecode = never,
  OutEncode = never,
>(
  registration: ShellIpcMethodRegistration<
    In,
    InWire,
    Out,
    OutWire,
    Err,
    Env,
    InDecode,
    InEncode,
    OutDecode,
    OutEncode
  >,
): ShellIpcMethod<Err | Schema.SchemaError, Env | InDecode | OutEncode> => ({
  channel: registration.channel,
  handler: (unparsed, evt) =>
    Schema.decodeUnknownEffect(registration.payload)(unparsed).pipe(
      Effect.flatMap((input) => registration.handler(input, evt)),
      Effect.flatMap((output) => Schema.encodeEffect(registration.result)(output)),
      Effect.withSpan("shell.ipc.method", { attributes: { channel: registration.channel } }),
    ),
});

export const defineSyncIpcMethod = <Out, OutWire, Err, Env, OutDecode = never, OutEncode = never>(
  registration: ShellSyncIpcMethodRegistration<Out, OutWire, Err, Env, OutDecode, OutEncode>,
): ShellSyncIpcMethod<Err | Schema.SchemaError, Env | OutEncode> => ({
  channel: registration.channel,
  handler: () =>
    registration.handler().pipe(
      Effect.flatMap((output) => Schema.encodeEffect(registration.result)(output)),
      Effect.withSpan("shell.ipc.method", { attributes: { channel: registration.channel } }),
    ),
});
