// Self-update for released builds. scripts/release-app.sh writes Contents/Resources/app-update.yml (a GitHub-releases
// feed on Kora's public repo) into the bundle it signs and notarizes; on Windows scripts/package-win.mjs --update-feed
// writes resources\app-update.yml. electron-updater reads it, checks shortly after launch and then hourly, and
// downloads a newer build in the background. macOS: Squirrel.Mac swaps the bundle when Kora quits (or right away from
// "Restart to update"). Windows: electron-updater's NSIS updater runs the new installer silently on quit or restart.
// Builds without that file — local builds, Kora Dev, checkouts — stay disabled and update by reinstalling.
//
// The daemon is not touched here: on the next launch kora-runtime.sh (kora-runtime.cjs on Windows) sees the new
// build's BUILD_ID, copies its runtime to ~/.kora/app and restarts the daemon.
import * as Electron from "electron";
import * as Scope from "effect/Scope";
import * as Ref from "effect/Ref";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import type {
  ShellUpdateState,
  ShellUpdateCheckResult,
  ShellUpdateActionResult,
} from "@kora/contracts";

import * as ShellTracing from "./ShellTracing.ts";
import * as ShellContext from "./ShellContext.ts";
import * as ShellConfig from "./ShellConfig.ts";
import {
  type UpdateEvent,
  initialUpdateState,
  describeUpdateStateForDialog,
  applyUpdateEvent,
  isRateLimitError,
} from "../updates/updateState.ts";
import { fetchUpdateControl, DEFAULT_UPDATE_CONTROL_URL } from "../updates/updateControl.ts";
import * as NativeUpdater from "../native/NativeUpdater.ts";
import * as NativeDialog from "../native/NativeDialog.ts";

const { logInfo, logWarning, logError, logDebug } =
  ShellTracing.makeScopedLogger("desktop-updates");

/** Written into the bundle by scripts/release-app.sh; its presence is what turns updates on. */
export const UPDATE_FEED_FILE = "app-update.yml";
const FIRST_CHECK_DELAY = Duration.seconds(3);
const CHECK_INTERVAL = Duration.hours(1);
const RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1000;

/** Squirrel can only replace a bundle the user can write: not one run from the disk image or from Downloads. */
export interface ApplicationsFolder {
  readonly isInside: () => boolean;
  /** Moves the bundle into /Applications and relaunches from there; false when it could not. */
  readonly moveInto: () => boolean;
}

const electronApplicationsFolder: ApplicationsFolder = {
  isInside: () => Electron.app.isInApplicationsFolder(),
  moveInto: () => Electron.app.moveToApplicationsFolder(),
};

export class ShellUpdater extends Context.Service<
  ShellUpdater,
  {
    readonly state: Effect.Effect<ShellUpdateState>;
    /**
     * Offer to move a released build that runs outside /Applications into it (it relaunches from there). True when
     * the app is relaunching and startup should stop.
     */
    readonly ensureInstalledLocation: Effect.Effect<boolean>;
    /** Listen to electron-updater and check shortly after launch, then hourly. Does nothing when disabled. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly check: Effect.Effect<ShellUpdateCheckResult>;
    readonly install: Effect.Effect<ShellUpdateActionResult>;
    /** The menu's "Check for Updates…": check, then say how it went in a dialog (offering a restart when ready). */
    readonly checkInteractively: Effect.Effect<void>;
    readonly subscribe: (
      subscriber: (snap: ShellUpdateState) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@kora/desktop/app/ShellUpdater") {}

export interface ShellUpdaterOptions {
  readonly fetchFn?: typeof fetch | undefined;
  readonly updateControlUrl?: string | undefined;
  readonly firstCheckDelay?: Duration.Duration | undefined;
  readonly checkInterval?: Duration.Duration | undefined;
}

export const make = (
  applications: ApplicationsFolder = electronApplicationsFolder,
  options?: ShellUpdaterOptions,
) =>
  Effect.gen(function* () {
    const envVars = yield* ShellContext.ShellContext;
    const cfg = yield* ShellConfig.ShellConfig;
    const fsys = yield* FileSystem.FileSystem;
    const nativeUpdater = yield* NativeUpdater.NativeUpdater;
    const nativeDialog = yield* NativeDialog.NativeDialog;
    const context1 = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context1);
    const runSync = Effect.runSyncWith(context1);
    // Forked (callers stay synchronous) and inside a span, which is what puts a log line in the desktop trace file
    // (<KORA_HOME>/userdata/logs/desktop.trace.ndjson) that a bug report attaches.
    const traceLog = (effect: Effect.Effect<void>) =>
      void runFork(effect.pipe(Effect.withSpan("shell.updates.log")));

    const hasFeed = yield* fsys
      .exists(envVars.path.join(envVars.resourcesPath, UPDATE_FEED_FILE))
      .pipe(Effect.orElseSucceed(() => false));
    const disabledReason =
      !envVars.isPackaged || envVars.isDevelopment
        ? "Development builds don't update themselves."
        : envVars.platform !== "darwin" && envVars.platform !== "win32"
          ? "Updates are only available on macOS and Windows."
          : Option.getOrNull(cfg.appFlavor) === "dev"
            ? "Kora Dev updates by reinstalling from its worktree (pnpm app:install:dev)."
            : !hasFeed
              ? "This is a local build: install Kora from its releases page to get updates."
              : cfg.disableUpdates
                ? "Updates are turned off (KORA_DISABLE_UPDATES)."
                : null;
    const enabled = disabledReason === null;

    const stateRef = yield* Ref.make(
      initialUpdateState({
        currentVersion: envVars.appVersion,
        runtimeInfo: envVars.runtimeInfo,
        disabledReason,
      }),
    );
    const listeners = new Set<(snap: ShellUpdateState) => void>();
    const checkingRef = yield* Ref.make(false);
    const rateLimitBackoffUntilRef = yield* Ref.make<number>(0);

    const dispatch = (evt: UpdateEvent) =>
      DateTime.now.pipe(
        Effect.map(DateTime.formatIso),
        Effect.flatMap((clock) =>
          Ref.modify(stateRef, (snap) => {
            const upcoming = applyUpdateEvent(snap, evt, clock);
            return [[snap.status, upcoming] as const, upcoming];
          }),
        ),
        Effect.map(([previousStatus, state]) => {
          if (previousStatus !== state.status) {
            traceLog(
              logInfo(`update status: ${state.status}`, {
                version: state.downloadedVersion ?? state.availableVersion,
                message: state.message,
              }),
            );
          }
          for (const subscriber of listeners) subscriber(state);
          return state;
        }),
      );

    const check = Effect.gen(function* () {
      const live = yield* Ref.get(stateRef);
      // Nothing to do when disabled, mid-check, or while an update is downloading / waiting to be installed.
      if (
        !live.enabled ||
        live.status === "downloading" ||
        live.status === "downloaded" ||
        (yield* Ref.getAndSet(checkingRef, true))
      ) {
        return { checked: false, state: live } satisfies ShellUpdateCheckResult;
      }

      // Check rate-limit backoff before making requests
      const rateLimitUntil = yield* Ref.get(rateLimitBackoffUntilRef);
      const now = yield* Clock.currentTimeMillis;
      if (now < rateLimitUntil) {
        yield* logInfo("update check skipped due to active rate-limit backoff");
        yield* Ref.set(checkingRef, false);
        return { checked: false, state: live } satisfies ShellUpdateCheckResult;
      }

      // Remote kill switch check before checkForUpdates()
      const controlUrl =
        options?.updateControlUrl ??
        Option.getOrElse(cfg.updateControlUrl, () => DEFAULT_UPDATE_CONTROL_URL);
      const control = yield* Effect.tryPromise(() =>
        fetchUpdateControl(controlUrl, options?.fetchFn ?? fetch),
      ).pipe(Effect.orElseSucceed(() => null));

      if (control?.pause) {
        const pauseMessage = control.message?.trim() || "Updates are temporarily paused.";
        yield* logInfo("update check paused by remote kill switch", {
          message: pauseMessage,
          minVersion: control.minVersion,
        });
        yield* dispatch({ type: "paused", message: pauseMessage });
        yield* Ref.set(checkingRef, false);
        return { checked: false, state: yield* Ref.get(stateRef) } satisfies ShellUpdateCheckResult;
      }

      yield* nativeUpdater.checkForUpdates.pipe(
        Effect.tap(() => Ref.set(rateLimitBackoffUntilRef, 0)),
        Effect.catch((err) => {
          const errString = String(err.cause);
          if (isRateLimitError(errString)) {
            return Clock.currentTimeMillis.pipe(
              Effect.flatMap((currentTime) =>
                Ref.set(rateLimitBackoffUntilRef, currentTime + RATE_LIMIT_BACKOFF_MS),
              ),
              Effect.andThen(
                logWarning("update check rate limited, backing off", { error: errString }),
              ),
              Effect.andThen(dispatch({ type: "error", message: errString })),
            );
          }
          return logWarning("update check failed", { error: errString }).pipe(
            Effect.andThen(dispatch({ type: "error", message: errString })),
          );
        }),
        Effect.ensuring(Ref.set(checkingRef, false)),
      );
      return { checked: true, state: yield* Ref.get(stateRef) } satisfies ShellUpdateCheckResult;
    }).pipe(Effect.withSpan("shell.updates.check"));

    const install = Effect.gen(function* () {
      const live = yield* Ref.get(stateRef);
      if (!live.enabled || live.status !== "downloaded") {
        return {
          accepted: false,
          completed: false,
          state: live,
        } satisfies ShellUpdateActionResult;
      }
      yield* logInfo("installing the downloaded update", { version: live.downloadedVersion });
      const accepted = yield* nativeUpdater.quitAndInstall.pipe(
        Effect.as(true),
        Effect.catch((err) =>
          logError("installing the update failed", { error: String(err.cause) }).pipe(
            Effect.andThen(dispatch({ type: "install-failed", message: String(err.cause) })),
            Effect.as(false),
          ),
        ),
      );
      return {
        accepted,
        completed: false,
        state: yield* Ref.get(stateRef),
      } satisfies ShellUpdateActionResult;
    }).pipe(Effect.withSpan("shell.updates.install"));

    const ensureInstalledLocation = Effect.gen(function* () {
      // macOS only: an NSIS install lives in a folder the user can write (per-user, %LOCALAPPDATA%\Programs).
      if (!enabled || envVars.platform !== "darwin" || applications.isInside()) return false;
      const { response } = yield* nativeDialog.showMessageBox({
        type: "question",
        message: "Move Kora to your Applications folder?",
        detail:
          "Kora can only update itself from the Applications folder. It will move itself there and reopen.",
        buttons: ["Move to Applications", "Not Now"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) {
        yield* logInfo(
          "running outside /Applications; automatic updates will fail until Kora is moved",
        );
        return false;
      }
      const moved = yield* Effect.try(() => applications.moveInto()).pipe(
        Effect.orElseSucceed(() => false),
      );
      if (!moved) {
        yield* nativeDialog.showErrorBox(
          "Kora could not move itself",
          "Drag Kora from where it is now into the Applications folder, then open it from there.",
        );
      }
      return moved;
    }).pipe(
      Effect.catch(() => Effect.succeed(false)),
      Effect.withSpan("shell.updates.ensureInstalledLocation"),
    );

    const begin = Effect.gen(function* () {
      if (!enabled) {
        yield* logInfo("automatic updates off", { reason: disabledReason });
        return;
      }
      yield* nativeUpdater.configure({
        info: (msg) => traceLog(logInfo(String(msg))),
        warn: (msg) => traceLog(logWarning(String(msg))),
        error: (msg) => traceLog(logError(String(msg))),
        debug: (msg) => traceLog(logDebug(msg)),
      });
      const on = (
        evtName: NativeUpdater.NativeUpdaterEvent,
        toEvent: (...argv: ReadonlyArray<unknown>) => UpdateEvent,
      ) =>
        nativeUpdater.on(evtName, (...argv) => {
          // Synchronous, so a check's result already reflects the events it fired.
          const effect = dispatch(toEvent(...argv));
          try {
            runSync(effect);
          } catch {
            void runFork(effect);
          }
        });
      const versionOf = (meta: unknown) =>
        typeof meta === "object" && meta !== null && "version" in meta
          ? String((meta as { version: unknown }).version)
          : "";
      yield* on("checking-for-update", () => ({ type: "checking" }));
      yield* on("update-available", (meta) => ({ type: "available", version: versionOf(meta) }));
      yield* on("update-not-available", () => ({ type: "not-available" }));
      yield* on("download-progress", (progress) => ({
        type: "progress",
        percent:
          typeof progress === "object" && progress !== null && "percent" in progress
            ? Number((progress as { percent: unknown }).percent)
            : 0,
      }));
      // electron-updater's "update-downloaded" means the zip arrived and its checksum matches. Squirrel.Mac then
      // checks the new bundle's signature against this app's before staging it; only its own "update-downloaded"
      // means quitting will install. (A rejected update arrives as "error" in between, and Restart would hang.)
      // On Windows the two are the same event: electron-updater checks the installer's sha512 and, for a signed
      // build, its Authenticode publisher before it fires (NativeUpdater.onInstallReady).
      yield* on("update-downloaded", (meta) => ({ type: "fetched", version: versionOf(meta) }));
      yield* nativeUpdater.onInstallReady(() => {
        const effect = dispatch({ type: "downloaded", version: null });
        try {
          runSync(effect);
        } catch {
          void runFork(effect);
        }
      });
      yield* on("error", (err) => ({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      }));
      yield* logInfo("automatic updates on", { version: envVars.appVersion });
      yield* Effect.forkScoped(
        Effect.sleep(options?.firstCheckDelay ?? FIRST_CHECK_DELAY).pipe(
          Effect.andThen(
            check.pipe(
              Effect.ignore,
              Effect.andThen(
                Effect.forever(
                  Effect.sleep(options?.checkInterval ?? CHECK_INTERVAL).pipe(
                    Effect.andThen(check.pipe(Effect.ignore)),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.withSpan("shell.updates.start"));

    const checkInteractively = Effect.gen(function* () {
      const earlier = yield* Ref.get(stateRef);
      if (earlier.enabled && earlier.status !== "downloaded") yield* check;
      const after = yield* Ref.get(stateRef);
      const { message, detail } = describeUpdateStateForDialog(after);
      if (after.status === "downloaded") {
        const { response } = yield* nativeDialog.showMessageBox({
          type: "info",
          message,
          detail,
          buttons: ["Restart Now", "Later"],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) yield* install;
        return;
      }
      yield* nativeDialog.showMessageBox({
        type: after.status === "error" ? "warning" : "info",
        message,
        detail,
        buttons: ["OK"],
      });
    }).pipe(
      Effect.catch((err) => logWarning("the update dialog failed", { error: err })),
      Effect.withSpan("shell.updates.checkInteractively"),
    );

    const subscribe = (subscriber: (snap: ShellUpdateState) => void) =>
      Effect.acquireRelease(
        Effect.sync(() => listeners.add(subscriber)),
        () => Effect.sync(() => listeners.delete(subscriber)),
      ).pipe(Effect.asVoid);

    return ShellUpdater.of({
      state: Ref.get(stateRef),
      ensureInstalledLocation,
      start: begin,
      check,
      install,
      checkInteractively,
      subscribe,
    });
  });

export const layer = Layer.effect(ShellUpdater, make());
