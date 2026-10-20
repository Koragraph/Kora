import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

import * as NativeApp from "../native/NativeApp.ts";
import * as ShellAppIdentity from "./ShellAppIdentity.ts";
import * as ShellAssets from "./ShellAssets.ts";
import * as ShellContext from "./ShellContext.ts";

// The layers under test get fakes; only the import of "electron" needs to resolve (no binary in a fresh checkout).
vi.mock("electron", () => ({}));

const APP_DATA = "/Users/sam/Library/Application Support";

interface Setup {
  /** Facts about this run, over a packaged macOS default. */
  readonly ctx?: Partial<
    Record<
      | "isPackaged"
      | "platform"
      | "displayName"
      | "appVersion"
      | "legacyUserDataDirName"
      | "userDataDirName",
      unknown
    >
  > & {
    readonly commitHashOverride?: Option.Option<string>;
  };
  /** Folders that exist on the fake disk (anything else does not). */
  readonly existing?: readonly string[];
  /** Make the existence probe itself fail. */
  readonly probeFails?: PlatformError.PlatformError;
  /** The bundled package.json's text (the commit hash source for packaged builds). */
  readonly manifest?: string;
  readonly dockPng?: string;
}

/** Builds the service over fakes; returns it with the calls made to the app. */
function identity(setup: Setup = {}) {
  const made: { name: string[]; about: Electron.AboutPanelOptionsOptions[]; dock: string[] } = {
    name: [],
    about: [],
    dock: [],
  };
  const ctx = {
    platform: "darwin",
    isPackaged: true,
    displayName: "Kora",
    appVersion: "2.0.1",
    appDataDirectory: APP_DATA,
    appRoot: "/Applications/Kora.app/Contents/Resources/app",
    userDataDirName: "kora",
    legacyUserDataDirName: "kora",
    commitHashOverride: Option.none(),
    ...setup.ctx,
  };
  const app = {
    setName: (n: string) => Effect.sync(() => void made.name.push(n)),
    setAboutPanelOptions: (o: Electron.AboutPanelOptionsOptions) =>
      Effect.sync(() => void made.about.push(o)),
    setDockIcon: (p: string) => Effect.sync(() => void made.dock.push(p)),
  };
  const assets: ShellAssets.ShellAssets["Service"] = {
    iconPaths: Effect.succeed({
      png: Option.fromNullishOr(setup.dockPng),
      ico: Option.none(),
      icns: Option.none(),
    }),
    resolveResourcePath: () => Effect.succeed(Option.none()),
  };
  const disk = FileSystem.layerNoop({
    exists: (p) =>
      setup.probeFails
        ? Effect.fail(setup.probeFails)
        : Effect.succeed((setup.existing ?? []).includes(p)),
    readFileString: () =>
      setup.manifest === undefined
        ? Effect.succeed('{"name":"kora"}')
        : Effect.succeed(setup.manifest),
  });
  const layer = ShellAppIdentity.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        disk,
        Layer.succeed(ShellAssets.ShellAssets, assets),
        Layer.succeed(NativeApp.NativeApp, app as unknown as NativeApp.NativeApp["Service"]),
        Layer.effect(
          ShellContext.ShellContext,
          Effect.map(
            Path.Path,
            (path) => ({ ...ctx, path }) as unknown as ShellContext.ShellContext["Service"],
          ),
        ).pipe(Layer.provide(NodePath.layerPosix)),
      ),
    ),
  );
  const run = <A, E>(
    body: (svc: ShellAppIdentity.ShellAppIdentity["Service"]) => Effect.Effect<A, E>,
  ) => Effect.flatMap(ShellAppIdentity.ShellAppIdentity, body).pipe(Effect.provide(layer));
  return { made, run };
}

describe("where user data lives", () => {
  it.effect("the current folder, unless an older install's folder already exists", () =>
    Effect.gen(function* () {
      const fresh = identity({
        ctx: { userDataDirName: "kora-dev-app", legacyUserDataDirName: "kora (Dev)" },
      });
      assert.equal(yield* fresh.run((s) => s.resolveUserDataPath), `${APP_DATA}/kora-dev-app`);
      const upgraded = identity({
        ctx: { userDataDirName: "kora-dev-app", legacyUserDataDirName: "kora (Dev)" },
        existing: [`${APP_DATA}/kora (Dev)`],
      });
      assert.equal(yield* upgraded.run((s) => s.resolveUserDataPath), `${APP_DATA}/kora (Dev)`);
    }),
  );

  it.effect("a failed probe is reported with the folder it was checking", () => {
    const denied = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "exists",
      description: "not allowed",
      pathOrDescriptor: `${APP_DATA}/kora`,
    });
    return identity({ probeFails: denied }).run((s) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(s.resolveUserDataPath);
        assert.instanceOf(failure, ShellAppIdentity.ShellUserDataPathResolutionError);
        assert.deepInclude(failure, { legacyPath: `${APP_DATA}/kora`, cause: denied });
        assert.equal(
          failure.message,
          `Failed to inspect legacy desktop user-data path at "${APP_DATA}/kora".`,
        );
      }),
    );
  });
});

describe("name, About panel and Dock icon", () => {
  it.effect(
    "an override commit hash is shortened to 12 lowercase characters for the About panel",
    () => {
      const t = identity({
        ctx: { commitHashOverride: Option.some("ABCDEF0123456789AA") },
        dockPng: "/kora.png",
      });
      return t.run((s) =>
        Effect.gen(function* () {
          yield* s.configure;
          assert.deepEqual(t.made.name, ["Kora"]);
          assert.deepEqual(t.made.about, [
            { applicationName: "Kora", applicationVersion: "2.0.1", version: "abcdef012345" },
          ]);
          // A bundle keeps its own icon (and any custom icon the user gave it).
          assert.deepEqual(t.made.dock, []);
        }),
      );
    },
  );

  it.effect(
    "a packaged build reads the hash from its package.json; garbage there reads as unknown",
    () =>
      Effect.gen(function* () {
        const good = identity({ manifest: '{"koraCommitHash":"0f1e2d3c4b5a"}' });
        yield* good.run((s) => s.configure);
        assert.equal(good.made.about[0]?.version, "0f1e2d3c4b5a");
        const bad = identity({ manifest: '{"koraCommitHash":"not-a-hash"}' });
        yield* bad.run((s) => s.configure);
        assert.equal(bad.made.about[0]?.version, "unknown");
      }),
  );

  it.effect("an unpackaged run on macOS sets the Dock icon (Electron would show its own)", () => {
    const t = identity({
      ctx: { isPackaged: false },
      dockPng: "/repo/assets/icons/checkout/mac-1024.png",
    });
    return t.run((s) =>
      Effect.gen(function* () {
        yield* s.configure;
        assert.deepEqual(t.made.dock, ["/repo/assets/icons/checkout/mac-1024.png"]);
        assert.equal(t.made.about[0]?.version, "unknown", "no override and not packaged: no hash");
      }),
    );
  });
});
