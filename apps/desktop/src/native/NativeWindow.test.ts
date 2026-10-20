import { assert, describe, it } from "@effect/vitest";
import { MachinePlatform } from "@kora/shared/hostMachine";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

const electron = vi.hoisted(() => ({
  focusApp: vi.fn(),
  construct: vi.fn(function FakeBrowserWindow() {}),
  allWindows: vi.fn((): unknown[] => []),
  focusedWindow: vi.fn((): unknown => null),
}));

vi.mock("electron", () => ({
  app: { focus: electron.focusApp },
  BrowserWindow: Object.assign(electron.construct, {
    getAllWindows: electron.allWindows,
    getFocusedWindow: electron.focusedWindow,
  }),
}));

import * as NativeWindow from "./NativeWindow.ts";

const onLinux = NativeWindow.layer.pipe(Layer.provide(Layer.succeed(MachinePlatform, "linux")));

/** A window double with only what each case needs; `destroyed` defaults to false. */
const fakeWindow = (id: number, extra: Record<string, unknown> = {}) =>
  ({ id, isDestroyed: vi.fn(() => false), ...extra }) as unknown as Electron.BrowserWindow;

/** Runs `effect`, expects it to die with a NativeWindowOperationError, and returns that error. */
const operationDefect = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    if (Exit.isSuccess(exit)) throw new Error("expected a defect, the operation succeeded");
    const error = Cause.squash(exit.cause);
    assert.instanceOf(error, NativeWindow.NativeWindowOperationError);
    return error as NativeWindow.NativeWindowOperationError;
  });

const run = <A, E>(body: (service: NativeWindow.NativeWindow["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(NativeWindow.NativeWindow, body).pipe(Effect.provide(onLinux));

beforeEach(() => {
  for (const spy of Object.values(electron)) spy.mockReset();
  electron.allWindows.mockReturnValue([]);
});

describe("creating a window", () => {
  it.effect(
    "a failed construction carries a plain snapshot of the request, not the raw options",
    () =>
      run((service) =>
        Effect.gen(function* () {
          const boom = new Error("BrowserWindow could not be constructed");
          electron.construct.mockImplementationOnce(function failing() {
            throw boom;
          });
          const request = {
            backgroundColor: "#000000",
            frame: true,
            height: 800,
            icon: {} as Electron.NativeImage,
            minHeight: 600,
            minWidth: 900,
            modal: false,
            show: false,
            title: "Kora",
            transparent: false,
            width: 1200,
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              partition: "persist:kora-preview-a",
              preload: "/app/preload.js",
              sandbox: true,
              spellcheck: false,
              webviewTag: true,
            },
          } satisfies Electron.BrowserWindowConstructorOptions;

          const failure = yield* Effect.flip(service.create(request));

          assert.instanceOf(failure, NativeWindow.NativeWindowCreateError);
          assert.strictEqual(failure.cause, boom);
          const prefs = failure.options.webPreferences;
          assert.deepEqual(
            [
              prefs.preload,
              prefs.partition,
              prefs.sandbox,
              prefs.contextIsolation,
              prefs.nodeIntegration,
              prefs.webviewTag,
            ],
            ["/app/preload.js", "persist:kora-preview-a", true, true, false, true],
          );
          assert.isNull(prefs.backgroundThrottling, "unset options are null, never undefined");
          const o = failure.options;
          assert.deepEqual(
            {
              size: [o.width, o.height],
              min: [o.minWidth, o.minHeight],
              flags: [o.show, o.modal, o.frame, o.transparent],
            },
            { size: [1200, 800], min: [900, 600], flags: [false, false, true, false] },
          );
          assert.equal(o.title, "Kora");
          assert.equal(o.backgroundColor, "#000000");
          // Non-serialisable or unlisted options never reach the error.
          assert.notProperty(failure.options, "icon");
          assert.notProperty(failure.options.webPreferences, "spellcheck");
          assert.equal(
            failure.message,
            'Failed to create Electron BrowserWindow "Kora" (1200x800).',
          );
          assert.notInclude(failure.message, boom.message);
          assert.deepEqual(electron.construct.mock.calls, [[request]]);
        }),
      ),
  );
});

describe("operations that fail inside Electron become defects with their context", () => {
  it.effect("listing windows", () =>
    run((service) =>
      Effect.gen(function* () {
        const boom = new Error("enumeration broke");
        electron.allWindows.mockImplementationOnce(() => {
          throw boom;
        });
        const error = yield* operationDefect(service.mainOrAnyWindow);
        assert.deepInclude(error, {
          operation: "list-windows",
          platform: "linux",
          windowId: null,
          channel: null,
        });
        assert.strictEqual(error.cause, boom);
        assert.notInclude(error.message, boom.message);
      }),
    ),
  );

  it.effect("revealing a window names the window", () =>
    run((service) =>
      Effect.gen(function* () {
        const boom = new Error("restore broke");
        const win = fakeWindow(41, {
          isMinimized: () => true,
          restore: () => {
            throw boom;
          },
        });
        const error = yield* operationDefect(service.reveal(win));
        assert.deepInclude(error, { operation: "reveal-window", windowId: 41, channel: null });
        assert.strictEqual(error.cause, boom);
      }),
    ),
  );

  it.effect("sending to the windows names the window and the channel", () =>
    run((service) =>
      Effect.gen(function* () {
        const boom = new Error("send broke");
        const win = fakeWindow(42, {
          webContents: {
            send: () => {
              throw boom;
            },
          },
        });
        electron.allWindows.mockReturnValueOnce([win]);
        const error = yield* operationDefect(service.sendAll("shell:update", { ready: true }));
        assert.deepInclude(error, {
          operation: "send-window-message",
          windowId: 42,
          channel: "shell:update",
        });
        assert.strictEqual(error.cause, boom);
      }),
    ),
  );

  it.effect("destroying every window keeps going after a failure and reports the first one", () =>
    run((service) =>
      Effect.gen(function* () {
        const boom = new Error("destroy broke");
        const broken = fakeWindow(43, {
          destroy: () => {
            throw boom;
          },
        });
        const next = fakeWindow(44, { destroy: vi.fn() });
        electron.allWindows.mockReturnValueOnce([broken, next]);
        const error = yield* operationDefect(service.destroyAll);
        assert.deepInclude(error, { operation: "destroy-window", windowId: 43, channel: null });
        assert.strictEqual(error.cause, boom);
        assert.lengthOf(
          vi.mocked((next as unknown as { destroy: () => void }).destroy).mock.calls,
          1,
        );
      }),
    ),
  );
});

describe("which windows count", () => {
  it.effect("appearance sync visits only windows still alive", () =>
    run((service) =>
      Effect.gen(function* () {
        const gone = fakeWindow(2, { isDestroyed: () => true });
        const alive = fakeWindow(1);
        electron.allWindows.mockReturnValue([gone, alive]);
        const visited: number[] = [];
        yield* service.syncAllAppearance((win) => Effect.sync(() => void visited.push(win.id)));
        assert.deepEqual(visited, [1]);
      }),
    ),
  );

  it.effect(
    "a preview page's popup (another session) is never the main window or a broadcast target",
    () =>
      run((service) =>
        Effect.gen(function* () {
          // App windows have no session in this mock; an OAuth popup carries its preview partition's session.
          const app = fakeWindow(60, { webContents: { send: vi.fn() } });
          const popup = fakeWindow(61, {
            webContents: { send: vi.fn(), session: { partition: "persist:kora-preview-x" } },
          });
          electron.allWindows.mockReturnValue([popup, app]);
          const sent = (w: Electron.BrowserWindow) =>
            vi.mocked(w.webContents.send).mock.calls.length;

          yield* service.sendAll("shell:web-state", "tab", { url: "https://x" });
          assert.deepEqual([sent(popup), sent(app)], [0, 1]);

          const current = yield* service.mainOrAnyWindow;
          assert.isTrue(Option.contains(current, app));

          electron.focusedWindow.mockReturnValueOnce(popup);
          const focused = yield* service.focusedOrMainWindow;
          assert.isTrue(Option.contains(focused, app));
        }),
      ),
  );

  it.effect("a registered main window wins until it is destroyed or cleared", () =>
    run((service) =>
      Effect.gen(function* () {
        let closed = false;
        const main = fakeWindow(70, { isDestroyed: () => closed });
        const other = fakeWindow(71);
        electron.allWindows.mockReturnValue([other, main]);
        yield* service.setMain(main);
        assert.isTrue(Option.contains(yield* service.main, main));
        closed = true;
        assert.isTrue(Option.isNone(yield* service.main));
        assert.isTrue(Option.contains(yield* service.mainOrAnyWindow, other));
        closed = false;
        yield* service.clearMain(Option.some(other));
        assert.isTrue(
          Option.contains(yield* service.main, main),
          "clearing another window leaves main alone",
        );
        yield* service.clearMain(Option.none());
        assert.isTrue(Option.isNone(yield* service.main));
      }),
    ),
  );
});
