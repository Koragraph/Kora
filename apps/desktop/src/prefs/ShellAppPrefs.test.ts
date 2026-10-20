import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ShellContext from "../app/ShellContext.ts";
import { packagedContextLayer } from "../testing/contextLayer.ts";
import * as ShellAppPrefs from "./ShellAppPrefs.ts";

const inTempHome = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "kora-shell-prefs-" })),
    Effect.flatMap((home) =>
      body.pipe(
        Effect.provide(
          ShellAppPrefs.layer.pipe(
            Layer.provideMerge(packagedContextLayer(home)),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

describe("desktop shell prefs", () => {
  it.effect("no file yet: load and get both give the defaults", () =>
    inTempHome(
      Effect.gen(function* () {
        const prefs = yield* ShellAppPrefs.ShellAppPrefs;
        const loaded = yield* prefs.load;
        assert.deepEqual(
          [loaded, yield* prefs.get],
          [ShellAppPrefs.DEFAULT_SHELL_PREFS, ShellAppPrefs.DEFAULT_SHELL_PREFS],
        );
      }),
    ),
  );

  it.effect("an unreadable file is replaced by the defaults rather than failing the launch", () =>
    inTempHome(
      Effect.gen(function* () {
        const { stateDir, desktopSettingsPath } = yield* ShellContext.ShellContext;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(stateDir, { recursive: true });
        yield* fs.writeFileString(desktopSettingsPath, "]]] not json");
        assert.deepEqual(
          yield* (yield* ShellAppPrefs.ShellAppPrefs).load,
          ShellAppPrefs.DEFAULT_SHELL_PREFS,
        );
      }),
    ),
  );
});
