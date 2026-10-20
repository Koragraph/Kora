import type * as Electron from "electron";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import * as ShellTracing from "./ShellTracing.ts";
import * as ShellState from "./ShellState.ts";
import * as ShellShutdown from "./ShellShutdown.ts";
import * as ShellContext from "./ShellContext.ts";
import * as ShellWindow from "../window/ShellWindow.ts";
import * as NativeWindow from "../native/NativeWindow.ts";
import * as NativeTheme from "../native/NativeTheme.ts";
import * as NativeApp from "../native/NativeApp.ts";

const { logInfo, logError, logWarning } = ShellTracing.makeScopedLogger("desktop-lifecycle");

/** The dev runner restarts the app when it exits with this code. */
const DEV_RESTART_EXIT_CODE = 75;

export class ShellLifecycleRelaunchError extends Schema.TaggedError<ShellLifecycleRelaunchError>()(
  "ShellLifecycleRelaunchError",
  { reason: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Desktop relaunch failed for reason "${this.reason}".`;
  }
}

export type ShellLifecycleRuntimeServices =
  | ShellContext.ShellContext
  | ShellShutdown.ShellShutdown
  | ShellState.ShellState
  | ShellWindow.ShellWindow
  | NativeApp.NativeApp
  | NativeTheme.NativeTheme;

export class ShellLifecycle extends Context.Service<
  ShellLifecycle,
  {
    /** Quit cleanly and start the app again; returns at once. */
    readonly relaunch: (reason: string) => Effect.Effect<void>;
    /** Wire Electron's app events, theme changes and process signals for the life of the scope. */
    readonly register: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@kora/desktop/app/ShellLifecycle") {}

// Save window geometry, run an optional extra step, then ask the backend side to wind down and wait for it.
const shutDownAndWait = (beforeRequest: Effect.Effect<void> = Effect.void) =>
  Effect.gen(function* () {
    const win = yield* ShellWindow.ShellWindow;
    const shutdown = yield* ShellShutdown.ShellShutdown;
    yield* win.saveMainWindowPlace;
    yield* beforeRequest;
    yield* shutdown.request;
    yield* shutdown.awaitComplete;
  });

const implementation = {
  relaunch: (reason: string) =>
    Effect.gen(function* () {
      const envVars = yield* ShellContext.ShellContext;
      const snap = yield* ShellState.ShellState;
      const application = yield* NativeApp.NativeApp;
      yield* logInfo("desktop relaunch requested", { reason });
      yield* Effect.gen(function* () {
        yield* Effect.yieldNow;
        yield* Ref.set(snap.quitting, true);
        yield* shutDownAndWait();
        if (envVars.isDevelopment) {
          yield* application.exit(DEV_RESTART_EXIT_CODE);
          return;
        }
        yield* application.relaunch({ execPath: process.execPath, args: process.argv.slice(1) });
        yield* application.exit(0);
      }).pipe(
        Effect.catchCause((cause) =>
          logError(new ShellLifecycleRelaunchError({ reason, cause }).message),
        ),
        Effect.forkDetach,
      );
    }),

  register: Effect.gen(function* () {
    const application = yield* NativeApp.NativeApp;
    const palette = yield* NativeTheme.NativeTheme;
    const nativeWindow = yield* NativeWindow.NativeWindow;
    const shellWindow = yield* ShellWindow.ShellWindow;
    const snap = yield* ShellState.ShellState;
    const context1 = yield* Effect.context<
      ShellLifecycleRuntimeServices | NativeWindow.NativeWindow
    >();
    const runFork = Effect.runForkWith(context1);
    const runSync = Effect.runSyncWith(context1);

    // Set once the updater (or our own second pass) has agreed the quit may go ahead.
    let quitAllowed = false;

    const destroyWindows = (fault: string) =>
      nativeWindow.destroyAll.pipe(Effect.catchCause(() => logWarning(fault)));

    yield* palette.onUpdated(() => {
      runFork(shellWindow.syncAppearance);
    });

    yield* application.onBeforeQuitForUpdate(() => {
      // Cancelling the quit that follows would break Squirrel's install and relaunch, so it is let through.
      quitAllowed = true;
      // Windows must be gone before that quit proceeds; a forked effect could lose the race.
      runSync(
        destroyWindows("failed to destroy windows before updater quit").pipe(
          Effect.andThen(logInfo("allowing updater-controlled quit")),
        ),
      );
    });

    yield* application.on("before-quit", (evt: Electron.Event) => {
      if (quitAllowed) {
        runSync(Ref.set(snap.quitting, true).pipe(Effect.andThen(logInfo("before-quit received"))));
        return;
      }
      // First pass: hold the quit, wind everything down, then quit again with permission.
      evt.preventDefault();
      runFork(
        Ref.set(snap.quitting, true).pipe(
          Effect.andThen(logInfo("before-quit received")),
          Effect.andThen(
            shutDownAndWait(destroyWindows("failed to destroy windows before shutdown")),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              quitAllowed = true;
              return application.quit;
            }),
          ),
        ),
      );
    });

    yield* application.on("activate", () => {
      runFork(
        Ref.get(snap.quitting).pipe(
          Effect.flatMap((quitting) =>
            quitting ? Effect.void : shellWindow.activate.pipe(Effect.ignore),
          ),
        ),
      );
    });

    yield* application.on(
      "child-process-gone",
      (_evt: Electron.Event, details: Electron.Details) => {
        runFork(
          logWarning("child process gone", {
            type: details.type,
            reason: details.reason,
            exitCode: details.exitCode,
            serviceName: details.serviceName,
            name: details.name,
          }),
        );
      },
    );

    yield* application.on(
      "render-process-gone",
      (
        _evt: Electron.Event,
        _webContents: Electron.WebContents,
        details: Electron.RenderProcessGoneDetails,
      ) => {
        runFork(
          logWarning("render process gone", {
            reason: details.reason,
            exitCode: details.exitCode,
          }),
        );
      },
    );

    // SIGINT/SIGTERM (a terminal Ctrl-C, `kill`) take the same graceful route as quitting from the menu.
    for (const abortSig of ["SIGINT", "SIGTERM"] as const) {
      const onSignal = () => {
        runFork(
          Ref.getAndSet(snap.quitting, true).pipe(
            Effect.flatMap((already) =>
              already
                ? Effect.void
                : logInfo("process signal received", { signal: abortSig }).pipe(
                    Effect.andThen(shutDownAndWait()),
                    Effect.andThen(application.quit),
                  ),
            ),
          ),
        );
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => process.on(abortSig, onSignal)),
        () => Effect.sync(() => process.removeListener(abortSig, onSignal)),
      );
    }
  }),
};

const make = Effect.gen(function* () {
  // Resolved once here, so callers of `relaunch` and `register` need no services of their own.
  const context1 = yield* Effect.context<
    ShellLifecycleRuntimeServices | NativeWindow.NativeWindow
  >();
  return ShellLifecycle.of({
    relaunch: (reason) => implementation.relaunch(reason).pipe(Effect.provideContext(context1)),
    register: implementation.register.pipe(Effect.provideContext(context1)),
  });
});

export const layer = Layer.effect(ShellLifecycle, make);
