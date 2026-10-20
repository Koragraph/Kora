import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as ShellAssets from "./ShellAssets.ts";
import * as ShellConfig from "./ShellConfig.ts";
import * as ShellContext from "./ShellContext.ts";

/** The assets service over a fake disk, for either a packaged app or a Linux dev checkout at /src/kora. */
function assetsFor(
  run: "packaged" | "checkout",
  exists: (path: string) => Effect.Effect<boolean, PlatformError.PlatformError>,
) {
  const checkout = run === "checkout";
  const context = ShellContext.layer({
    homeDirectory: "/home/sam",
    dirname: "/src/kora/apps/desktop/dist-electron",
    appVersion: "0.1.14",
    runningUnderArm64Translation: false,
    ...(checkout
      ? {
          platform: "linux",
          processArch: "x64",
          isPackaged: false,
          appPath: "/src/kora",
          resourcesPath: "/src/kora/apps/desktop/resources",
        }
      : {
          platform: "darwin",
          processArch: "arm64",
          isPackaged: true,
          appPath: "/Applications/Kora.app/Contents/Resources/app.asar",
          resourcesPath: "/Applications/Kora.app/Contents/Resources",
        }),
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        ShellConfig.layerTest(checkout ? { VITE_DEV_SERVER_URL: "http://localhost:5733" } : {}),
        NodePath.layerPosix,
        NodeServices.layer,
      ),
    ),
  );
  const layer = ShellAssets.layer.pipe(
    Layer.provide(Layer.merge(FileSystem.layerNoop({ exists }), context)),
  );
  return ShellAssets.ShellAssets.pipe(Effect.provide(layer));
}

describe("ShellAssets", () => {
  it.effect("a dev checkout uses the checkout icons from the source tree (no icns off macOS)", () =>
    Effect.gen(function* () {
      const assets = yield* assetsFor("checkout", (p) =>
        Effect.succeed(p.includes("/assets/icons/checkout/")),
      );
      const { ico, png, icns } = yield* assets.iconPaths;
      assert.isTrue(Option.isNone(icns));
      assert.isTrue(Option.getOrThrow(ico).endsWith("/assets/icons/checkout/windows.ico"));
      assert.isTrue(Option.getOrThrow(png).endsWith("/assets/icons/checkout/square-1024.png"));
    }),
  );

  it.effect(
    "a failed probe names the file and the path it was checking, never the system's own text",
    () => {
      const target = "/Applications/Kora.app/Contents/Resources/extra.bin";
      const denied = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "exists",
        pathOrDescriptor: target,
        description: "sandbox detail that must stay out of messages",
      });
      return Effect.gen(function* () {
        const assets = yield* assetsFor("packaged", (p) =>
          p === target ? Effect.fail(denied) : Effect.succeed(false),
        );
        const failure = yield* Effect.flip(assets.resolveResourcePath("extra.bin"));
        assert.instanceOf(failure, ShellAssets.ShellAssetProbeError);
        assert.deepInclude(failure, {
          fileName: "extra.bin",
          candidatePath: target,
          cause: denied,
        });
        assert.equal(failure.message, `Failed to probe desktop asset "extra.bin" at ${target}.`);
        assert.notInclude(failure.message, "sandbox detail");
      });
    },
  );
});
