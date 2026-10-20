import * as Electron from "electron";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

export interface NativeAppMetadata {
  readonly runningUnderArm64Translation: boolean;
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly appVersion: string;
}

export class NativeAppMetadataReadError extends Schema.TaggedError<NativeAppMetadataReadError>()(
  "NativeAppMetadataReadError",
  {
    property: Schema.Literals(["app-version", "app-path"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to read Electron app metadata property "${this.property}".`;
  }
}

export class NativeAppWhenReadyError extends Schema.TaggedError<NativeAppWhenReadyError>()(
  "NativeAppWhenReadyError",
  {
    isPackaged: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to wait for the Electron app to become ready (packaged: ${this.isPackaged}).`;
  }
}

export class NativeApp extends Context.Service<
  NativeApp,
  {
    readonly metadata: Effect.Effect<NativeAppMetadata, NativeAppMetadataReadError>;
    readonly name: Effect.Effect<string>;
    readonly systemLocale: Effect.Effect<string>;
    readonly whenReady: Effect.Effect<void, NativeAppWhenReadyError>;
    readonly quit: Effect.Effect<void>;
    readonly exit: (code: number) => Effect.Effect<void>;
    readonly relaunch: (opts: Electron.RelaunchOptions) => Effect.Effect<void>;
    readonly setPath: (
      label: Parameters<typeof Electron.app.setPath>[0],
      loc: string,
    ) => Effect.Effect<void>;
    readonly setName: (label: string) => Effect.Effect<void>;
    readonly setAboutPanelOptions: (opts: Electron.AboutPanelOptionsOptions) => Effect.Effect<void>;
    readonly setDockIcon: (iconPath: string) => Effect.Effect<void>;
    /** Runs while Squirrel is about to quit the app to install an update. */
    readonly onBeforeQuitForUpdate: (
      subscriber: () => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly on: (
      evtName: string,
      subscriber: (...argv: Array<any>) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@kora/desktop/native/NativeApp") {}

const readMetadata = Effect.gen(function* () {
  const appVersion = yield* Effect.try({
    try: () => Electron.app.getVersion(),
    catch: (reason) => new NativeAppMetadataReadError({ property: "app-version", cause: reason }),
  });
  const appPath = yield* Effect.try({
    try: () => Electron.app.getAppPath(),
    catch: (reason) => new NativeAppMetadataReadError({ property: "app-path", cause: reason }),
  });
  return {
    runningUnderArm64Translation: Electron.app.runningUnderARM64Translation === true,
    resourcesPath: process.resourcesPath,
    isPackaged: Electron.app.isPackaged,
    appPath,
    appVersion,
  } satisfies NativeAppMetadata;
});

const make = NativeApp.of({
  metadata: readMetadata,
  name: Effect.sync(() => Electron.app.name),
  // macOS answers in POSIX style (en_GB), which Intl refuses. The packaged app also ships a single en-US locale
  // pak, so app.getLocale() would always say en-US: the OS locale is the one worth reporting.
  systemLocale: Effect.sync(() => Electron.app.getSystemLocale().replaceAll("_", "-")),
  whenReady: Effect.tryPromise({
    try: () => Electron.app.whenReady(),
    catch: (reason) =>
      new NativeAppWhenReadyError({ isPackaged: Electron.app.isPackaged, cause: reason }),
  }).pipe(Effect.asVoid),
  quit: Effect.sync(() => Electron.app.quit()),
  exit: (code) => Effect.sync(() => Electron.app.exit(code)),
  relaunch: (opts) => Effect.sync(() => Electron.app.relaunch(opts)),
  setPath: (label, loc) => Effect.sync(() => Electron.app.setPath(label, loc)),
  setName: (label) => Effect.sync(() => Electron.app.setName(label)),
  setAboutPanelOptions: (opts) => Effect.sync(() => Electron.app.setAboutPanelOptions(opts)),
  setDockIcon: (iconPath) => Effect.sync(() => Electron.app.dock?.setIcon(iconPath)),
  onBeforeQuitForUpdate: (subscriber) =>
    Effect.acquireRelease(
      Effect.sync(() => Electron.autoUpdater.on("before-quit-for-update", subscriber)),
      () =>
        Effect.sync(() =>
          Electron.autoUpdater.removeListener("before-quit-for-update", subscriber),
        ),
    ).pipe(Effect.asVoid),
  on: (evtName, subscriber) =>
    Effect.acquireRelease(
      Effect.sync(() => Electron.app.on(evtName as never, subscriber)),
      () => Effect.sync(() => Electron.app.removeListener(evtName as never, subscriber)),
    ).pipe(Effect.asVoid),
});

export const layer = Layer.succeed(NativeApp, make);
