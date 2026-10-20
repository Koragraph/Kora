import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Result from "effect/Result";

import * as ShellContext from "../app/ShellContext.ts";
import { packagedContextLayer } from "../testing/contextLayer.ts";
import * as ShellClientPrefs from "./ShellClientPrefs.ts";

const HOME = "/no-such-home";

/** Reads the prefs over a fake disk and collects every log line with its annotations. */
function readOver(disk: Parameters<typeof FileSystem.layerNoop>[0]) {
  const logged: Array<{ args: unknown; annotations: Record<string, unknown> }> = [];
  const capture = Logger.make(({ fiber, message }) => {
    logged.push({
      args: message,
      annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
    });
  });
  const services = ShellClientPrefs.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(packagedContextLayer(HOME), NodeServices.layer, FileSystem.layerNoop(disk)),
    ),
  );
  return Effect.gen(function* () {
    const outcome = yield* Effect.result((yield* ShellClientPrefs.ShellClientPrefs).get);
    return { outcome, logged, file: (yield* ShellContext.ShellContext).clientSettingsPath };
  }).pipe(
    Effect.provide(Layer.merge(services, Logger.layer([capture], { mergeWithExisting: false }))),
  );
}

describe("what the client prefs read logs", () => {
  it.effect("a missing file is normal: none, and nothing logged", () =>
    Effect.map(readOver({}), ({ outcome, logged }) => {
      assert.isTrue(Result.isSuccess(outcome) && Option.isNone(outcome.success));
      assert.lengthOf(logged, 0);
    }),
  );

  it.effect("any other disk failure fails the read and logs once, with the file path", () => {
    const denied = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFileString",
      pathOrDescriptor: `${HOME}/userdata/client-prefs.json`,
    });
    return Effect.map(
      readOver({ readFileString: () => Effect.fail(denied) }),
      ({ outcome, logged, file }) => {
        if (!Result.isFailure(outcome)) return assert.fail("the read should fail");
        assert.instanceOf(outcome.failure, ShellClientPrefs.ShellClientPrefsReadError);
        assert.strictEqual(outcome.failure.cause, denied);
        assert.deepEqual(
          logged.map((l) => l.args),
          [["Could not read desktop client settings.", denied]],
        );
        assert.equal(logged[0]?.annotations.settingsPath, file);
      },
    );
  });

  it.effect(
    "a document that does not decode fails the read and logs the schema error, with the file path",
    () =>
      Effect.map(
        readOver({ readFileString: () => Effect.succeed("{{") }),
        ({ outcome, logged, file }) => {
          if (!Result.isFailure(outcome)) return assert.fail("the read should fail");
          assert.equal(outcome.failure.operation, "decode-document");
          assert.lengthOf(logged, 1);
          const [text, detail] = logged[0]!.args as [string, { _tag?: string }];
          assert.deepEqual(
            [text, detail?._tag],
            ["Could not decode desktop client settings.", "SchemaError"],
          );
          assert.equal(logged[0]?.annotations.settingsPath, file);
        },
      ),
  );
});
