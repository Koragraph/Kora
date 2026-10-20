import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

import * as NativeApp from "../native/NativeApp.ts";
import * as NativeTheme from "../native/NativeTheme.ts";
import * as NativeWindow from "../native/NativeWindow.ts";
import * as ShellWindow from "../window/ShellWindow.ts";
import * as ShellContext from "./ShellContext.ts";
import * as ShellLifecycle from "./ShellLifecycle.ts";
import * as ShellShutdown from "./ShellShutdown.ts";
import * as ShellState from "./ShellState.ts";

// The layers under test get fakes; only the import of "electron" needs to resolve (no binary in a fresh checkout).
vi.mock("electron", () => ({}));

type Listener = (...args: readonly unknown[]) => void;
const never = (what: string) => Effect.die(`the lifecycle should not ${what}`);

/**
 * Everything the lifecycle talks to, as fakes that append to one `log`. `app` holds the listeners the lifecycle
 * registered, by event name, so a test can fire an Electron app event.
 */
function world(
  opts: { platform?: NodeJS.Platform; shutdown?: ShellShutdown.ShellShutdown["Service"] } = {},
) {
  const log: string[] = [];
  const app = new Map<string, Listener>();
  const note = (entry: string) => Effect.sync(() => void log.push(entry));
  const listen = (name: string, fn: Listener) =>
    Effect.acquireRelease(
      Effect.sync(() => void app.set(name, fn)),
      () => Effect.sync(() => void app.delete(name)),
    ).pipe(Effect.asVoid);

  const nativeApp: NativeApp.NativeApp["Service"] = {
    exit: (code) => note(`exit ${code}`),
    metadata: never("read metadata"),
    name: Effect.succeed("Kora"),
    on: (name, fn) => listen(name, fn as Listener),
    onBeforeQuitForUpdate: (fn) => listen("before-quit-for-update", fn),
    quit: note("quit"),
    relaunch: () => note("relaunch"),
    setAboutPanelOptions: () => Effect.void,
    setDockIcon: () => Effect.void,
    setName: () => Effect.void,
    setPath: () => Effect.void,
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
  };
  const windows: NativeWindow.NativeWindow["Service"] = {
    clearMain: () => Effect.void,
    create: () => never("create a window"),
    mainOrAnyWindow: never("look for a window"),
    destroyAll: note("destroy windows"),
    focusedOrMainWindow: never("look for a focused window"),
    main: never("read the main window"),
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    setMain: () => Effect.void,
    syncAllAppearance: () => Effect.void,
  };
  const shellWindow: ShellWindow.ShellWindow["Service"] = {
    activate: note("activate"),
    createMain: never("create the main window"),
    openMainWhenDaemonReady: Effect.void,
    sendMenuAction: () => Effect.void,
    ensureMain: never("create the main window"),
    saveMainWindowPlace: note("save bounds"),
    handleBackendNotReady: Effect.void,
    handleBackendReady: () => Effect.void,
    revealOrCreateMain: never("create the main window"),
    setSplashMessage: () => Effect.void,
    showStartupSplash: Effect.void,
    syncAppearance: Effect.void,
    zoomMain: () => Effect.void,
  };
  const theme: NativeTheme.NativeTheme["Service"] = {
    shouldUseDarkColors: Effect.succeed(true),
    setSource: () => Effect.void,
    onUpdated: () => Effect.void,
  };
  const context = {
    platform: opts.platform ?? "darwin",
    isDevelopment: false,
  } as ShellContext.ShellContext["Service"];

  const layer = ShellLifecycle.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(NativeApp.NativeApp, nativeApp),
        Layer.succeed(NativeWindow.NativeWindow, windows),
        Layer.succeed(ShellWindow.ShellWindow, shellWindow),
        Layer.succeed(NativeTheme.NativeTheme, theme),
        Layer.succeed(ShellContext.ShellContext, context),
        opts.shutdown
          ? Layer.succeed(ShellShutdown.ShellShutdown, opts.shutdown)
          : ShellShutdown.layer,
      ),
    ),
    Layer.provideMerge(ShellState.layer),
  );
  const fire = (name: string, ...args: unknown[]) => app.get(name)?.(...args);
  return { log, layer, fire };
}

/** A before-quit event that remembers whether it was cancelled. */
const quitEvent = () => {
  const e = { cancelled: false, preventDefault: () => void (e.cancelled = true) };
  return e;
};

describe("the updater's quit", () => {
  it.effect.each(["darwin", "win32", "linux"] as const)(
    "is never cancelled on %s, and windows go first",
    (platform) => {
      const w = world({ platform });
      return Effect.scoped(
        Effect.gen(function* () {
          yield* (yield* ShellLifecycle.ShellLifecycle).register;
          w.fire("before-quit-for-update");
          yield* Effect.yieldNow;
          const event = quitEvent();
          w.fire("before-quit", event as unknown as Electron.Event);
          // Cancelling it would stop Squirrel from installing the update and relaunching.
          assert.isFalse(event.cancelled);
          assert.include(w.log, "destroy windows");
          assert.isTrue(yield* Ref.get((yield* ShellState.ShellState).quitting));
        }),
      ).pipe(Effect.provide(w.layer));
    },
  );
});

describe("an ordinary quit", () => {
  it.effect("is held while the app winds down: bounds, windows, backend, then the real quit", () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const w = world({
        shutdown: {
          request: Effect.sync(() => void w.log.push("ask backend to stop")).pipe(
            Effect.andThen(Deferred.succeed(asked, undefined)),
            Effect.asVoid,
          ),
          awaitRequest: Deferred.await(asked),
          markComplete: Deferred.succeed(finished, undefined).pipe(Effect.asVoid),
          awaitComplete: Deferred.await(finished),
          isComplete: Deferred.isDone(finished),
        },
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* (yield* ShellLifecycle.ShellLifecycle).register;
          const event = quitEvent();
          w.fire("before-quit", event as unknown as Electron.Event);
          assert.isTrue(event.cancelled, "the first quit is held");
          yield* Deferred.await(asked);
          assert.deepEqual(
            w.log,
            ["save bounds", "destroy windows", "ask backend to stop"],
            "nothing quits before the backend is done",
          );
          yield* Deferred.succeed(finished, undefined);
          for (let i = 0; i < 20 && !w.log.includes("quit"); i++) yield* Effect.yieldNow;
          assert.deepEqual(w.log.at(-1), "quit");
        }),
      ).pipe(Effect.provide(w.layer));
    }),
  );
});

describe("activation (clicking the Dock icon)", () => {
  it.effect("brings the window back, except while quitting", () => {
    const w = world();
    return Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* ShellLifecycle.ShellLifecycle).register;
        w.fire("activate");
        for (let i = 0; i < 10 && !w.log.includes("activate"); i++) yield* Effect.yieldNow;
        assert.deepEqual(w.log, ["activate"]);

        yield* Ref.set((yield* ShellState.ShellState).quitting, true);
        w.fire("activate");
        for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
        assert.deepEqual(w.log, ["activate"], "no second activation while quitting");
      }),
    ).pipe(Effect.provide(w.layer));
  });
});
