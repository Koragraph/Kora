import * as Ref from "effect/Ref";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Cause from "effect/Cause";

import * as Electron from "electron";
import * as ShellUpdater from "./ShellUpdater.ts";
import * as ShellTracing from "./ShellTracing.ts";
import * as ShellState from "./ShellState.ts";
import * as ShellShutdown from "./ShellShutdown.ts";
import * as ShellLifecycle from "./ShellLifecycle.ts";
import * as ShellLaunch from "./ShellLaunch.ts";
import * as ShellContext from "./ShellContext.ts";
import * as ShellAppIdentity from "./ShellAppIdentity.ts";
import {
  LAUNCH_RECORD_FILE,
  filterRecentTimestamps,
  readLaunchTimestamps,
  recordLaunchAttempt,
  runCrashLoopRecovery,
  shouldTriggerCrashLoop,
} from "./CrashLoopGuard.ts";
import * as ShellWindow from "../window/ShellWindow.ts";
import * as ShellApplicationMenu from "../window/ShellApplicationMenu.ts";
import * as LoginEnv from "../shell/LoginEnv.ts";
import * as ShellAppPrefs from "../prefs/ShellAppPrefs.ts";
import * as NativeProtocol from "../native/NativeProtocol.ts";
import * as NativeDialog from "../native/NativeDialog.ts";
import * as NativeApp from "../native/NativeApp.ts";
import { installShellIpcHandlers } from "../ipc/ShellIpcHandlers.ts";
import * as ShellKoraDaemon from "../backend/ShellKoraDaemon.ts";

const bootstrapLog = ShellTracing.makeScopedLogger("desktop-bootstrap");
const startupLog = ShellTracing.makeScopedLogger("desktop-startup");

/** Report a startup failure once (one dialog even if several stages fail), then wind the app down. */
const failStartup = (stage: string, msg: string, addl?: string) =>
  Effect.gen(function* () {
    const snap = yield* ShellState.ShellState;
    const shutdown = yield* ShellShutdown.ShellShutdown;
    const application = yield* NativeApp.NativeApp;
    const dialog = yield* NativeDialog.NativeDialog;
    yield* startupLog.logError("fatal startup error", {
      stage,
      message: msg,
      ...(addl === undefined ? {} : { detail: addl }),
    });
    const alreadyQuitting = yield* Ref.getAndSet(snap.quitting, true);
    if (!alreadyQuitting) {
      yield* dialog.showErrorBox(
        "Kora failed to start",
        `Stage: ${stage}\n${msg}${addl === undefined ? "" : `\n${addl}`}`,
      );
    }
    yield* shutdown.request;
    yield* application.quit;
  });

/** Run a stage; if it fails, show the fatal dialog and then fail with the original cause. */
const guardStage = (stage: string) => {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapCause((reason) => {
        const err = Cause.squash(reason);
        const stack = err instanceof Error ? err.stack : undefined;
        return failStartup(stage, Cause.pretty(reason), stack);
      }),
    );
};

const bootstrap = Effect.gen(function* () {
  const envVars = yield* ShellContext.ShellContext;
  const prefsObj = yield* (yield* ShellAppPrefs.ShellAppPrefs).get;
  const protocol = yield* NativeProtocol.NativeProtocol;
  const snap = yield* ShellState.ShellState;
  const shellWindow = yield* ShellWindow.ShellWindow;
  const scheme = NativeProtocol.getShellScheme(envVars.isDevelopment);

  // The renderer is served from the bundled client (or Vite in development) and never through the daemon, so the
  // window can open before the daemon is up.
  if (envVars.isDevelopment) {
    if (envVars.devServerUrl._tag !== "Some") {
      return yield* Effect.die(new Error("A development run needs VITE_DEV_SERVER_URL."));
    }
    yield* protocol.registerDesktopProtocol({
      scheme,
      targetOrigin: envVars.devServerUrl.value,
    });
  } else {
    yield* protocol.registerDesktopProtocol({
      scheme,
      assetDirectory: envVars.clientAssetsDir,
    });
  }

  yield* installShellIpcHandlers();
  yield* bootstrapLog.logInfo("bootstrap ipc handlers registered");

  if (!prefsObj.localHostEnabled) {
    yield* bootstrapLog.logInfo("bootstrap skipping local environment (disabled in settings)");
    if (!(yield* Ref.get(snap.quitting))) yield* shellWindow.openMainWhenDaemonReady;
    return;
  }

  if (yield* Ref.get(snap.quitting)) return;
  const daemon = yield* ShellKoraDaemon.ShellKoraDaemon;
  const launch = yield* ShellLaunch.ShellLaunch;
  // Tied to the program's lifetime, but it never stops the daemon: that outlives the app.
  yield* Effect.forkScoped(daemon.start);
  yield* launch.start.pipe(
    Effect.matchEffect({
      onSuccess: () => bootstrapLog.logInfo("desktop app control socket ready"),
      onFailure: (err) =>
        bootstrapLog.logError("desktop app control socket unavailable", { error: err }),
    }),
  );
}).pipe(Effect.withSpan("shell.bootstrap"));

const startup = Effect.gen(function* () {
  const envVars = yield* ShellContext.ShellContext;
  const application = yield* NativeApp.NativeApp;
  const identity = yield* ShellAppIdentity.ShellAppIdentity;
  const appPrefs = yield* ShellAppPrefs.ShellAppPrefs;

  // The user's PATH and locale first: everything spawned afterwards inherits them.
  yield* (yield* LoginEnv.LoginEnv).installIntoProcess;

  const userData = yield* identity.resolveUserDataPath;
  yield* application.setPath("userData", userData);
  const crashDumpsPath = envVars.path.join(userData, "crashDumps");
  yield* application.setPath("crashDumps", crashDumpsPath).pipe(Effect.catch(() => Effect.void));

  yield* Effect.try({
    try: () => {
      if (typeof Electron.crashReporter?.start === "function") {
        Electron.crashReporter.start({
          uploadToServer: false,
        });
      }
    },
    catch: () => undefined,
  }).pipe(Effect.ignore);

  yield* startupLog.logInfo("runtime logging configured", { logDir: envVars.logDir });

  // Crash-loop guard: check for 2+ consecutive failures within ~2 minutes
  const launchRecordPath = envVars.path.join(userData, LAUNCH_RECORD_FILE);
  const existingTimestamps = yield* Effect.tryPromise(() =>
    readLaunchTimestamps(launchRecordPath),
  ).pipe(Effect.orElseSucceed(() => []));
  const recentTimestamps = filterRecentTimestamps(existingTimestamps);

  if (shouldTriggerCrashLoop(recentTimestamps)) {
    yield* startupLog.logWarning("startup crash loop detected, showing recovery dialog");
    yield* runCrashLoopRecovery(userData);
    return;
  }

  yield* Effect.tryPromise(() => recordLaunchAttempt(launchRecordPath)).pipe(
    Effect.catch(() => Effect.void),
  );

  yield* appPrefs.load;

  // Called before ready so the name and About panel exist early, and again after so the dock icon applies.
  yield* identity.configure;
  yield* (yield* ShellLifecycle.ShellLifecycle).register;

  yield* application.whenReady.pipe(
    Effect.withSpan("shell.electron.whenReady"),
    guardStage("whenReady"),
  );
  yield* startupLog.logInfo("app ready");

  yield* identity.configure;
  yield* (yield* ShellApplicationMenu.ShellApplicationMenu).configure;

  const updater = yield* ShellUpdater.ShellUpdater;
  // A released build run from a disk image offers to move itself to /Applications and relaunches from there.
  if (yield* updater.ensureInstalledLocation) return;

  yield* updater.start;
  yield* bootstrap.pipe(guardStage("bootstrap"));
}).pipe(Effect.withSpan("shell.startup"));

export const program = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const shutdown = yield* ShellShutdown.ShellShutdown;
  const runId = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "").slice(0, 12);
  yield* Effect.annotateCurrentSpan({ scope: "desktop", runId });

  yield* Effect.gen(function* () {
    // Deliberately not stopping the daemon: it serves the CLI, hooks and workers after the app is gone.
    yield* Effect.addFinalizer(() => shutdown.markComplete);
    yield* startup.pipe(guardStage("startup"));
    yield* shutdown.awaitRequest;
  }).pipe(Effect.annotateLogs({ scope: "desktop", runId }));
}).pipe(Effect.withSpan("shell.app"), Effect.scoped);
