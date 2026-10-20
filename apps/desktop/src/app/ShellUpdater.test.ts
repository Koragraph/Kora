import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ShellUpdateState } from "@kora/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";

import * as NativeDialog from "../native/NativeDialog.ts";
import * as NativeUpdater from "../native/NativeUpdater.ts";
import * as ShellConfig from "./ShellConfig.ts";
import * as ShellContext from "./ShellContext.ts";
import * as ShellUpdater from "./ShellUpdater.ts";

// The updater asks Electron where the app lives; these tests give it its location explicitly.
vi.mock("electron", () => ({
  app: { isInApplicationsFolder: () => true, moveToApplicationsFolder: () => false },
}));

/**
 * A stand-in for electron-updater: `checkForUpdates` fires the events a real check against `latest` would, in the
 * order seen live — electron-updater's update-downloaded first, then Squirrel's verdict on the signature.
 */
function makeFakeUpdater(
  latest: string | null,
  squirrel: "accepts" | "rejects" | "rateLimit" = "accepts",
) {
  const listeners = new Map<string, Set<(...args: ReadonlyArray<unknown>) => void>>();
  const installReady = new Set<() => void>();
  const emit = (event: string, ...args: ReadonlyArray<unknown>) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const calls = { checks: 0, installs: 0, configured: false };
  const layer = Layer.succeed(NativeUpdater.NativeUpdater, {
    configure: () =>
      Effect.sync(() => {
        calls.configured = true;
      }),
    checkForUpdates: Effect.gen(function* () {
      calls.checks += 1;
      if (squirrel === "rateLimit") {
        return yield* Effect.fail(
          new NativeUpdater.NativeUpdaterCheckError({
            cause: new Error("HttpError: 429 Too Many Requests"),
          }),
        );
      }
      emit("checking-for-update");
      if (latest === null) {
        emit("update-not-available", { version: "0.2.0" });
        return;
      }
      emit("update-available", { version: latest });
      emit("download-progress", { percent: 50 });
      emit("update-downloaded", { version: latest });
      if (squirrel === "accepts") for (const listener of installReady) listener();
      else
        emit(
          "error",
          // What Squirrel.Mac reports when the downloaded bundle is signed by someone else.
          new Error(
            [
              "Code signature at URL file:///tmp/Kora.app/ did not pass validation:",
              "code failed to satisfy specified code requirement(s)",
            ].join(" "),
          ),
        );
    }),
    quitAndInstall: Effect.sync(() => {
      calls.installs += 1;
    }),
    on: (eventName, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const set = listeners.get(eventName) ?? new Set();
          set.add(listener);
          listeners.set(eventName, set);
        }),
        () => Effect.sync(() => listeners.get(eventName)?.delete(listener)),
      ),
    onInstallReady: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => installReady.add(listener)),
        () => Effect.sync(() => installReady.delete(listener)),
      ),
  } satisfies NativeUpdater.NativeUpdater["Service"]);
  return { layer, calls };
}

const dialogLayer = Layer.succeed(NativeDialog.NativeDialog, {
  pickFolder: () => Effect.succeed(Option.none()),
  showMessageBox: () => Effect.succeed({ response: 1, checkboxChecked: false }),
  showErrorBox: () => Effect.void,
} satisfies NativeDialog.NativeDialog["Service"]);

const inApplications: ShellUpdater.ApplicationsFolder = {
  isInside: () => true,
  moveInto: () => false,
};

const withUpdater = <A>(
  options: {
    readonly withFeed: boolean;
    readonly latest: string | null;
    readonly squirrel?: "accepts" | "rejects" | "rateLimit";
    readonly env?: Record<string, string>;
    readonly applications?: ShellUpdater.ApplicationsFolder;
    readonly platform?: NodeJS.Platform;
    readonly fetchFn?: typeof fetch;
  },
  body: (
    updater: ShellUpdater.ShellUpdater["Service"],
    calls: ReturnType<typeof makeFakeUpdater>["calls"],
  ) => Effect.Effect<A, never, Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const disk = yield* FileSystem.FileSystem;
      const resourcesPath = yield* disk.makeTempDirectoryScoped({ prefix: "kora-updater-test-" });
      if (options.withFeed) {
        yield* disk.writeFileString(
          `${resourcesPath}/${ShellUpdater.UPDATE_FEED_FILE}`,
          "provider: github\nowner: agilkatakam\nrepo: kora\n",
        );
      }
      const fake = makeFakeUpdater(options.latest, options.squirrel);
      const contextLayer = ShellContext.layer({
        dirname: "/Applications/Kora.app/Contents/Resources/app/dist-electron",
        homeDirectory: resourcesPath,
        platform: options.platform ?? "darwin",
        processArch: "arm64",
        appVersion: "0.2.0",
        appPath: "/Applications/Kora.app/Contents/Resources/app",
        isPackaged: true,
        resourcesPath,
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(NodeServices.layer, ShellConfig.layerTest(options.env ?? {})),
        ),
      );
      const updaterLayer = Layer.effect(
        ShellUpdater.ShellUpdater,
        ShellUpdater.make(options.applications ?? inApplications, {
          fetchFn: options.fetchFn,
        }),
      ).pipe(Layer.provide(Layer.mergeAll(contextLayer, fake.layer, dialogLayer)));
      const updater = yield* ShellUpdater.ShellUpdater.pipe(Effect.provide(updaterLayer));
      return yield* body(updater, fake.calls);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

describe("ShellUpdater", () => {
  it.effect("a bundle without app-update.yml (a local build) never checks", () =>
    withUpdater({ withFeed: false, latest: "0.3.0" }, (updater, calls) =>
      Effect.gen(function* () {
        yield* updater.start;
        const state = yield* updater.state;
        assert.equal(state.status, "disabled");
        assert.match(state.message ?? "", /local build/);
        const result = yield* updater.check;
        assert.isFalse(result.checked);
        assert.equal(calls.checks, 0);
        assert.isFalse(calls.configured);
      }),
    ),
  );

  it.effect("Kora Dev is never updated from the public feed", () =>
    withUpdater({ withFeed: true, latest: "0.3.0", env: { KORA_APP_FLAVOR: "dev" } }, (updater) =>
      Effect.gen(function* () {
        const state = yield* updater.state;
        assert.equal(state.status, "disabled");
        assert.match(state.message ?? "", /Kora Dev/);
      }),
    ),
  );

  it.effect("a released build downloads a newer version and installs it on request", () =>
    withUpdater({ withFeed: true, latest: "0.3.0" }, (updater, calls) =>
      Effect.gen(function* () {
        const seen: Array<ShellUpdateState["status"]> = [];
        yield* updater.subscribe((state) => seen.push(state.status));
        yield* updater.start;
        assert.isTrue(calls.configured);
        const result = yield* updater.check;
        assert.isTrue(result.checked);
        assert.equal(result.state.status, "downloaded");
        assert.equal(result.state.downloadedVersion, "0.3.0");
        assert.deepEqual(seen, [
          "checking",
          "downloading",
          "downloading",
          "downloading",
          "downloaded",
        ]);

        // Once downloaded, further checks are skipped until the user restarts.
        assert.isFalse((yield* updater.check).checked);
        const installed = yield* updater.install;
        assert.isTrue(installed.accepted);
        assert.equal(calls.installs, 1);
      }),
    ),
  );

  it.effect("an update Squirrel rejects is an error, and Restart refuses it", () =>
    withUpdater({ withFeed: true, latest: "0.3.0", squirrel: "rejects" }, (updater, calls) =>
      Effect.gen(function* () {
        yield* updater.start;
        const result = yield* updater.check;
        assert.equal(result.state.status, "error");
        assert.match(result.state.message ?? "", /code-signature check/);
        assert.isFalse((yield* updater.install).accepted);
        assert.equal(calls.installs, 0);
      }),
    ),
  );

  it.effect("up to date: nothing to install", () =>
    withUpdater({ withFeed: true, latest: null }, (updater, calls) =>
      Effect.gen(function* () {
        yield* updater.start;
        const result = yield* updater.check;
        assert.equal(result.state.status, "up-to-date");
        assert.isFalse((yield* updater.install).accepted);
        assert.equal(calls.installs, 0);
      }),
    ),
  );

  it.effect("offers to move a released build into /Applications", () =>
    Effect.gen(function* () {
      let moved = 0;
      const outside: ShellUpdater.ApplicationsFolder = {
        isInside: () => false,
        moveInto: () => {
          moved += 1;
          return true;
        },
      };
      // The fake dialog answers "Not Now" (response 1): the app keeps running from where it is.
      const relaunching = yield* withUpdater(
        { withFeed: true, latest: null, applications: outside },
        (updater) => updater.ensureInstalledLocation,
      );
      assert.isFalse(relaunching);
      assert.equal(moved, 0);
      // A local build never asks.
      const local = yield* withUpdater(
        { withFeed: false, latest: null, applications: outside },
        (updater) => updater.ensureInstalledLocation,
      );
      assert.isFalse(local);
    }),
  );

  it.effect("a released Windows build updates too, and never offers the Applications move", () =>
    Effect.gen(function* () {
      const outside: ShellUpdater.ApplicationsFolder = {
        isInside: () => false,
        moveInto: () => {
          throw new Error("never on Windows");
        },
      };
      const opts = {
        withFeed: true,
        latest: "0.3.0",
        platform: "win32",
        applications: outside,
      } as const;
      const result = yield* withUpdater(opts, (updater) =>
        updater.start.pipe(Effect.andThen(updater.check)),
      );
      assert.equal(result.state.status, "downloaded");
      assert.isFalse(yield* withUpdater(opts, (updater) => updater.ensureInstalledLocation));
    }),
  );

  it.effect("Linux builds stay off", () =>
    withUpdater({ withFeed: true, latest: "0.3.0", platform: "linux" }, (updater, calls) =>
      Effect.gen(function* () {
        yield* updater.start;
        const state = yield* updater.state;
        assert.equal(state.status, "disabled");
        assert.match(state.message ?? "", /macOS and Windows/);
        assert.equal(calls.checks, 0);
      }),
    ),
  );

  it.effect("remote kill switch pauses updates and skips checkForUpdates", () => {
    const pausedFetch = (() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            pause: true,
            message: "Updates paused due to an emergency bug fix.",
            minVersion: "0.2.0",
          }),
      })) as unknown as typeof fetch;

    return withUpdater(
      { withFeed: true, latest: "0.3.0", fetchFn: pausedFetch },
      (updater, calls) =>
        Effect.gen(function* () {
          yield* updater.start;
          const result = yield* updater.check;
          assert.isFalse(result.checked);
          assert.equal(calls.checks, 0);
          assert.equal(result.state.status, "idle");
          assert.equal(result.state.message, "Updates paused due to an emergency bug fix.");
        }),
    );
  });

  it.effect("remote kill switch fails open on network error and proceeds with update check", () => {
    const failingFetch = (() =>
      Promise.reject(new Error("Network offline"))) as unknown as typeof fetch;

    return withUpdater(
      { withFeed: true, latest: "0.3.0", fetchFn: failingFetch },
      (updater, calls) =>
        Effect.gen(function* () {
          yield* updater.start;
          const result = yield* updater.check;
          assert.isTrue(result.checked);
          assert.equal(calls.checks, 1);
          assert.equal(result.state.status, "downloaded");
        }),
    );
  });

  it.effect("rate-limit 429 backs off and skips subsequent check", () =>
    withUpdater({ withFeed: true, latest: "0.3.0", squirrel: "rateLimit" }, (updater, calls) =>
      Effect.gen(function* () {
        yield* updater.start;
        const first = yield* updater.check;
        assert.isTrue(first.checked);
        assert.equal(calls.checks, 1);
        assert.equal(first.state.status, "error");
        assert.match(first.state.message ?? "", /rate limit/i);

        // Subsequent check during backoff does not hammer GitHub (skips checkForUpdates)
        const second = yield* updater.check;
        assert.isFalse(second.checked);
        assert.equal(calls.checks, 1);
      }),
    ),
  );
});
