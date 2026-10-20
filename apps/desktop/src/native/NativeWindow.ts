import * as Electron from "electron";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import { MachinePlatform } from "@kora/shared/hostMachine";

import { isAppWindow } from "./AppWindows.ts";

const NullableString = Schema.NullOr(Schema.String);
const NullableNumber = Schema.NullOr(Schema.Number);
const NullableBoolean = Schema.NullOr(Schema.Boolean);

// What a failed BrowserWindow construction reports: only plain, serialisable facts about the request.
const CreateOptionsSnapshot = Schema.Struct({
  title: NullableString,
  width: NullableNumber,
  height: NullableNumber,
  minWidth: NullableNumber,
  minHeight: NullableNumber,
  show: NullableBoolean,
  modal: NullableBoolean,
  frame: NullableBoolean,
  transparent: NullableBoolean,
  backgroundColor: NullableString,
  webPreferences: Schema.Struct({
    preload: NullableString,
    partition: NullableString,
    backgroundThrottling: NullableBoolean,
    sandbox: NullableBoolean,
    contextIsolation: NullableBoolean,
    nodeIntegration: NullableBoolean,
    webviewTag: NullableBoolean,
  }),
});

export const snapshotOptions = (
  opts: Electron.BrowserWindowConstructorOptions,
): typeof CreateOptionsSnapshot.Type => {
  const prefsObj = opts.webPreferences;
  return {
    title: opts.title ?? null,
    width: opts.width ?? null,
    height: opts.height ?? null,
    minWidth: opts.minWidth ?? null,
    minHeight: opts.minHeight ?? null,
    show: opts.show ?? null,
    modal: opts.modal ?? null,
    frame: opts.frame ?? null,
    transparent: opts.transparent ?? null,
    backgroundColor: opts.backgroundColor ?? null,
    webPreferences: {
      preload: prefsObj?.preload ?? null,
      partition: prefsObj?.partition ?? null,
      backgroundThrottling: prefsObj?.backgroundThrottling ?? null,
      sandbox: prefsObj?.sandbox ?? null,
      contextIsolation: prefsObj?.contextIsolation ?? null,
      nodeIntegration: prefsObj?.nodeIntegration ?? null,
      webviewTag: prefsObj?.webviewTag ?? null,
    },
  };
};

export class NativeWindowCreateError extends Schema.TaggedError<NativeWindowCreateError>()(
  "NativeWindowCreateError",
  { options: CreateOptionsSnapshot, cause: Schema.Defect() },
) {
  override get message() {
    const { title, width, height } = this.options;
    const extent = width !== null && height !== null ? ` (${width}x${height})` : "";
    return `Failed to create Electron BrowserWindow "${title ?? "untitled"}"${extent}.`;
  }
}

export class NativeWindowOperationError extends Schema.TaggedError<NativeWindowOperationError>()(
  "NativeWindowOperationError",
  {
    cause: Schema.Defect(),
    channel: Schema.NullOr(Schema.String),
    windowId: Schema.NullOr(Schema.Number),
    platform: Schema.String,
    operation: Schema.Literals([
      "destroy-window",
      "send-window-message",
      "reveal-window",
      "inspect-window",
      "get-focused-window",
      "list-windows",
    ]),
  },
) {
  override get message() {
    const win = this.windowId === null ? "" : ` for window ${this.windowId}`;
    const chan = this.channel === null ? "" : ` on channel "${this.channel}"`;
    return `Electron window operation "${this.operation}" failed${win}${chan} on ${this.platform}.`;
  }
}

export class NativeWindow extends Context.Service<
  NativeWindow,
  {
    readonly syncAllAppearance: <Err, Env>(
      sync: (win: Electron.BrowserWindow) => Effect.Effect<void, Err, Env>,
    ) => Effect.Effect<void, Err, Env>;
    readonly destroyAll: Effect.Effect<void>;
    /** Send to every app window (never to a preview page's popups). */
    readonly sendAll: (chan: string, ...argv: readonly unknown[]) => Effect.Effect<void>;
    /** Bring a window forward: restore, show and focus it. */
    readonly reveal: (win: Electron.BrowserWindow) => Effect.Effect<void>;
    readonly clearMain: (win: Option.Option<Electron.BrowserWindow>) => Effect.Effect<void>;
    readonly setMain: (win: Electron.BrowserWindow) => Effect.Effect<void>;
    readonly focusedOrMainWindow: Effect.Effect<Option.Option<Electron.BrowserWindow>>;
    readonly mainOrAnyWindow: Effect.Effect<Option.Option<Electron.BrowserWindow>>;
    /** The registered main window, unless it has been destroyed. */
    readonly main: Effect.Effect<Option.Option<Electron.BrowserWindow>>;
    readonly create: (
      opts: Electron.BrowserWindowConstructorOptions,
    ) => Effect.Effect<Electron.BrowserWindow, NativeWindowCreateError>;
  }
>()("@kora/desktop/native/NativeWindow") {}

const make = Effect.gen(function* () {
  const hostOs = yield* MachinePlatform;
  let mainWindow: Electron.BrowserWindow | undefined;

  const operationError = (
    operation1: NativeWindowOperationError["operation"],
    reason: unknown,
    more: { windowId?: number; channel?: string } = {},
  ) =>
    new NativeWindowOperationError({
      operation: operation1,
      platform: hostOs,
      windowId: more.windowId ?? null,
      channel: more.channel ?? null,
      cause: reason,
    });

  // Run a synchronous Electron call; a failure is a defect carrying the operation context.
  const guarded = <Ok>(
    operation1: NativeWindowOperationError["operation"],
    exec: () => Ok,
    more?: { windowId?: number; channel?: string },
  ) =>
    Effect.try({ try: exec, catch: (reason) => operationError(operation1, reason, more) }).pipe(
      Effect.orDie,
    );

  const liveAppWindows = guarded("list-windows", () =>
    Electron.BrowserWindow.getAllWindows().filter((win) => isAppWindow(win) && !win.isDestroyed()),
  );

  const main = Effect.sync(() =>
    mainWindow && !mainWindow.isDestroyed() ? Option.some(mainWindow) : Option.none(),
  );

  const mainOrAnyWindow = Effect.gen(function* () {
    const registered = yield* main;
    if (Option.isSome(registered)) return registered;
    return Option.fromNullishOr((yield* liveAppWindows)[0]);
  });

  const focusedOrMainWindow = Effect.gen(function* () {
    const focused = yield* guarded("get-focused-window", () =>
      Electron.BrowserWindow.getFocusedWindow(),
    );
    if (focused && isAppWindow(focused) && !focused.isDestroyed()) return Option.some(focused);
    return yield* mainOrAnyWindow;
  });

  return NativeWindow.of({
    create: (opts) =>
      Effect.try({
        try: () => new Electron.BrowserWindow(opts),
        catch: (reason) =>
          new NativeWindowCreateError({ options: snapshotOptions(opts), cause: reason }),
      }),
    main,
    mainOrAnyWindow,
    focusedOrMainWindow,
    setMain: (win) =>
      Effect.sync(() => {
        mainWindow = win;
      }),
    clearMain: (win) =>
      Effect.sync(() => {
        if (Option.isNone(win) || mainWindow === win.value) mainWindow = undefined;
      }),
    reveal: (win) =>
      guarded(
        "reveal-window",
        () => {
          if (win.isDestroyed()) return;
          if (win.isMinimized()) win.restore();
          if (!win.isVisible()) win.show();
          if (hostOs === "darwin") Electron.app.focus({ steal: true });
          win.focus();
        },
        { windowId: win.id },
      ),
    sendAll: (chan, ...argv) =>
      Effect.gen(function* () {
        for (const win of yield* liveAppWindows) {
          yield* guarded("send-window-message", () => win.webContents.send(chan, ...argv), {
            windowId: win.id,
            channel: chan,
          });
        }
      }),
    destroyAll: Effect.gen(function* () {
      const windows = yield* guarded("list-windows", () => Electron.BrowserWindow.getAllWindows());
      let firstFailure: NativeWindowOperationError | undefined;
      for (const win of windows) {
        try {
          win.destroy();
        } catch (reason) {
          firstFailure ??= operationError("destroy-window", reason, { windowId: win.id });
        }
      }
      if (firstFailure) return yield* Effect.die(firstFailure);
    }),
    syncAllAppearance: (sync) =>
      Effect.gen(function* () {
        const windows = yield* guarded("list-windows", () =>
          Electron.BrowserWindow.getAllWindows(),
        );
        for (const win of windows) {
          if (!win.isDestroyed()) yield* sync(win);
        }
      }),
  });
});

export const layer = Layer.effect(NativeWindow, make);
