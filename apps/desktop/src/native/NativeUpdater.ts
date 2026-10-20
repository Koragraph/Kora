// electron-updater's autoUpdater behind a service (ShellUpdater owns the policy; tests swap this layer for a fake).
// The autoUpdater singleton is built on first property access — never at import — so a build without an update feed
// (ShellUpdater disabled) never constructs it.
import { autoUpdater } from "electron-updater";
import * as Electron from "electron";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

export type NativeUpdaterEvent =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

export interface NativeUpdaterLogger {
  readonly info: (msg?: unknown) => void;
  readonly warn: (msg?: unknown) => void;
  readonly error: (msg?: unknown) => void;
  readonly debug: (msg: string) => void;
}

export class NativeUpdaterCheckError extends Schema.TaggedError<NativeUpdaterCheckError>()(
  "NativeUpdaterCheckError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Checking for updates failed.";
  }
}

export class NativeUpdaterInstallError extends Schema.TaggedError<NativeUpdaterInstallError>()(
  "NativeUpdaterInstallError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Installing the downloaded update failed.";
  }
}

export class NativeUpdater extends Context.Service<
  NativeUpdater,
  {
    /** Download a found update in the background and install it when the app quits; never prereleases or downgrades. */
    readonly configure: (logger: NativeUpdaterLogger) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, NativeUpdaterCheckError>;
    /** Quit, let Squirrel swap the bundle (Windows: run the NSIS installer silently), relaunch. */
    readonly quitAndInstall: Effect.Effect<void, NativeUpdaterInstallError>;
    readonly on: (
      evtName: NativeUpdaterEvent,
      subscriber: (...argv: ReadonlyArray<unknown>) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Squirrel.Mac accepted the downloaded update (its signature matches this app's) and staged it: only now will
     * quitting install it. electron-updater's own "update-downloaded" fires earlier, before that check. Windows has no
     * Squirrel step: electron-updater's NSIS updater verifies the installer (sha512, Authenticode publisher when the
     * feed names one) before its "update-downloaded", so that event is the ready signal there.
     */
    readonly onInstallReady: (subscriber: () => void) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@kora/desktop/native/NativeUpdater") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = NativeUpdater.of({
  configure: (logger) =>
    Effect.sync(() => {
      autoUpdater.logger = logger;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.allowPrerelease = false;
      autoUpdater.allowDowngrade = false;
    }),
  checkForUpdates: Effect.tryPromise({
    try: async () => {
      const outcomeVal = await autoUpdater.checkForUpdates();
      // A download failure is reported through the "error" event; the promise must not go unhandled as well.
      outcomeVal?.downloadPromise?.catch(() => undefined);
    },
    catch: (reason) => new NativeUpdaterCheckError({ cause: reason }),
  }),
  quitAndInstall: Effect.try({
    // Windows: silent, so the assisted installer's pages don't reappear on every update.
    // oxlint-disable-next-line kora/no-global-process-runtime -- Electron's autoUpdater runs outside the Effect runtime
    try: () => autoUpdater.quitAndInstall(process.platform === "win32", true),
    catch: (reason) => new NativeUpdaterInstallError({ cause: reason }),
  }),
  on: (evtName, subscriber) => {
    const dest = autoUpdater as unknown as {
      on: (evtName: string, subscriber: (...argv: Array<unknown>) => void) => void;
      removeListener: (evtName: string, subscriber: (...argv: Array<unknown>) => void) => void;
    };
    return Effect.acquireRelease(
      Effect.sync(() => dest.on(evtName, subscriber)),
      () => Effect.sync(() => dest.removeListener(evtName, subscriber)),
    ).pipe(Effect.asVoid);
  },
  onInstallReady: (subscriber) => {
    const cb = () => subscriber();
    // oxlint-disable-next-line kora/no-global-process-runtime -- Electron's autoUpdater runs outside the Effect runtime
    if (process.platform === "win32")
      return Effect.acquireRelease(
        Effect.sync(() => autoUpdater.on("update-downloaded", cb)),
        () => Effect.sync(() => autoUpdater.removeListener("update-downloaded", cb)),
      ).pipe(Effect.asVoid);
    return Effect.acquireRelease(
      Effect.sync(() => Electron.autoUpdater.on("update-downloaded", cb)),
      () => Effect.sync(() => Electron.autoUpdater.removeListener("update-downloaded", cb)),
    ).pipe(Effect.asVoid);
  },
});

export const layer = Layer.succeed(NativeUpdater, make);
