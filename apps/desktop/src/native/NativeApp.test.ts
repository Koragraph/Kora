import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

// One fake `app`: every method is a spy; the readers return fixed facts tests can override once.
const fake = vi.hoisted(() => {
  const app = {
    name: "Kora",
    isPackaged: true,
    runningUnderARM64Translation: false,
    getVersion: vi.fn(() => "4.5.6"),
    getAppPath: vi.fn(() => "/Applications/Kora.app/Contents/Resources/app"),
    getSystemLocale: vi.fn(() => "de-AT"),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    removeListener: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
    relaunch: vi.fn(),
    setPath: vi.fn(),
    setName: vi.fn(),
    setAboutPanelOptions: vi.fn(),
    dock: { setIcon: vi.fn() },
  };
  const autoUpdater = { on: vi.fn(), removeListener: vi.fn() };
  return { app, autoUpdater };
});

vi.mock("electron", () => fake);

import * as NativeApp from "./NativeApp.ts";

const withApp = <A, E>(body: (app: NativeApp.NativeApp["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(NativeApp.NativeApp, body).pipe(Effect.provide(NativeApp.layer));

beforeEach(() => {
  for (const spy of [
    fake.app.on,
    fake.app.removeListener,
    fake.autoUpdater.on,
    fake.autoUpdater.removeListener,
  ])
    spy.mockClear();
});

describe("metadata", () => {
  it.effect("collects version, paths and packaging facts in one read", () =>
    withApp((app) =>
      Effect.map(app.metadata, (meta) =>
        assert.deepEqual(meta, {
          appVersion: "4.5.6",
          appPath: "/Applications/Kora.app/Contents/Resources/app",
          isPackaged: true,
          resourcesPath: process.resourcesPath,
          runningUnderArm64Translation: false,
        }),
      ),
    ),
  );

  it.effect.each([
    ["app-version", () => fake.app.getVersion],
    ["app-path", () => fake.app.getAppPath],
  ] as const)("names the %s property when reading it throws", ([property, reader]) =>
    withApp((app) =>
      Effect.gen(function* () {
        const boom = new Error(`${property} unreadable`);
        reader().mockImplementationOnce(() => {
          throw boom;
        });
        const failure = yield* Effect.flip(app.metadata);
        assert.instanceOf(failure, NativeApp.NativeAppMetadataReadError);
        assert.deepInclude(failure, { property, cause: boom });
        assert.equal(
          failure.message,
          `Failed to read Electron app metadata property "${property}".`,
        );
      }),
    ),
  );
});

describe("system locale", () => {
  it.effect("is the OS locale as Intl spells it", () =>
    withApp((app) =>
      Effect.gen(function* () {
        assert.equal(yield* app.systemLocale, "de-AT");
        fake.app.getSystemLocale.mockImplementationOnce(() => "pt_BR");
        assert.equal(
          yield* app.systemLocale,
          "pt-BR",
          "macOS answers POSIX-style; underscores become hyphens",
        );
      }),
    ),
  );
});

describe("readiness", () => {
  it.effect(
    "a rejected whenReady becomes a typed error that says whether the app is packaged",
    () =>
      withApp((app) =>
        Effect.gen(function* () {
          const boom = new Error("never became ready");
          fake.app.whenReady.mockRejectedValueOnce(boom);
          const failure = yield* Effect.flip(app.whenReady);
          assert.instanceOf(failure, NativeApp.NativeAppWhenReadyError);
          assert.deepInclude(failure, { isPackaged: true, cause: boom });
          assert.equal(
            failure.message,
            "Failed to wait for the Electron app to become ready (packaged: true).",
          );
        }),
      ),
  );
});

describe("listeners live exactly as long as their scope", () => {
  it.effect("app events", () =>
    withApp((app) =>
      Effect.gen(function* () {
        const handler = vi.fn();
        yield* Effect.scoped(app.on("open-url", handler));
        assert.deepEqual(fake.app.on.mock.calls, [["open-url", handler]]);
        assert.deepEqual(fake.app.removeListener.mock.calls, [["open-url", handler]]);
      }),
    ),
  );

  it.effect("the updater's quit-for-update hook", () =>
    withApp((app) =>
      Effect.gen(function* () {
        const handler = vi.fn();
        yield* Effect.scoped(app.onBeforeQuitForUpdate(handler));
        const pair = ["before-quit-for-update", handler];
        assert.deepEqual(fake.autoUpdater.on.mock.calls, [pair]);
        assert.deepEqual(fake.autoUpdater.removeListener.mock.calls, [pair]);
      }),
    ),
  );
});
