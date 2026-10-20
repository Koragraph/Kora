import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClientPrefsSchema, DEFAULT_CLIENT_PREFS, type ClientPrefs } from "@kora/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ShellConfig from "../app/ShellConfig.ts";
import * as ShellContext from "../app/ShellContext.ts";
import * as ShellClientPrefs from "./ShellClientPrefs.ts";

/** A document far from the defaults: nested records, arrays, a tagged union and null all have to survive a save. */
const customized: ClientPrefs = {
  ...DEFAULT_CLIENT_PREFS,
  timestampFormat: "24-hour",
  fontSizeCode: 14,
  wordWrap: true,
  diffLayout: "stacked",
  browserDefaultViewport: { _tag: "preset", presetId: "nest-hub", width: 1024, height: 600 },
  browserProfiles: [{ id: "client", name: "Client work", kind: "persistent" }],
  browserDefaultProfileId: "client",
  sidebarProjectGroupingOverrides: { "local:/Users/sam/code/acme": "separate" },
  loadBalancingWeights: { local: 100 },
  onboardingCompletedAt: null,
};

const asJson = Schema.encodeEffect(Schema.fromJsonString(ClientPrefsSchema));
const fromJson = Schema.decodeEffect(Schema.fromJsonString(ClientPrefsSchema));
const keysOf = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * A fresh KORA_HOME with the prefs service on it. `body` gets the service, the file path it uses, and helpers to
 * write or read that file directly.
 */
const inFreshHome = <A, E, R>(
  body: (t: {
    prefs: ShellClientPrefs.ShellClientPrefs["Service"];
    file: string;
    ctx: ShellContext.ShellContext["Service"];
    disk: FileSystem.FileSystem;
    put: (text: string, file?: string) => Effect.Effect<void, PlatformError.PlatformError>;
    read: () => Effect.Effect<string, PlatformError.PlatformError>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const disk = yield* FileSystem.FileSystem;
    const home = yield* disk.makeTempDirectoryScoped({ prefix: "kora-client-prefs-" });
    const context = ShellContext.layer({
      homeDirectory: home,
      dirname: "/src/kora/apps/desktop/src",
      appPath: "/src/kora",
      resourcesPath: "/nonexistent",
      isPackaged: true,
      appVersion: "0.1.14",
      platform: "darwin",
      processArch: "arm64",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(Layer.merge(ShellConfig.layerTest({ KORA_HOME: home }), NodeServices.layer)),
    );
    const layer = ShellClientPrefs.layer.pipe(
      Layer.provideMerge(context),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* Effect.gen(function* () {
      const ctx = yield* ShellContext.ShellContext;
      const file = ctx.clientSettingsPath;
      const put = (text: string, at = file) =>
        disk
          .makeDirectory(ctx.stateDir, { recursive: true })
          .pipe(Effect.andThen(disk.writeFileString(at, text)));
      return yield* body({
        prefs: yield* ShellClientPrefs.ShellClientPrefs,
        file,
        ctx,
        disk,
        put,
        read: () => disk.readFileString(file),
      });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("reading and writing", () => {
  it.effect("nothing saved yet reads as none", () =>
    inFreshHome(({ prefs }) => Effect.map(prefs.get, (got) => assert.isTrue(Option.isNone(got)))),
  );

  it.effect("a saved document reads back whole, stored flat (no `settings` wrapper)", () =>
    inFreshHome(({ prefs, read }) =>
      Effect.gen(function* () {
        yield* prefs.set(customized);
        assert.deepEqual(Option.getOrThrow(yield* prefs.get), customized);
        assert.deepEqual(yield* fromJson(yield* read()), customized);
        assert.notProperty(yield* keysOf(yield* read()), "settings");
      }),
    ),
  );

  it.effect(
    "a client-settings.json from before the rename is read until the first save writes client-prefs.json",
    () =>
      inFreshHome(({ prefs, file, put, disk }) =>
        Effect.gen(function* () {
          assert.isTrue(file.endsWith("/client-prefs.json"));
          const older = file.replace(/client-prefs\.json$/, "client-settings.json");
          yield* put(yield* asJson(customized), older);
          assert.deepEqual(Option.getOrThrow(yield* prefs.get), customized);

          const next = { ...customized, fontSizeCode: 16 };
          yield* prefs.set(next);
          assert.isTrue(yield* disk.exists(file));
          assert.deepEqual(Option.getOrThrow(yield* prefs.get), next);
          assert.isTrue(yield* disk.exists(older), "kept for a downgrade, just no longer read");
        }),
      ),
  );
});

describe("documents written by hand or by older versions", () => {
  it.effect.each([
    [
      "JSON with comments and a trailing comma",
      '{\n  // hand edited\n  "timestampFormat": "24-hour",\n}\n',
      "24-hour",
    ],
    [
      "the old { settings: … } wrapper",
      '{ "settings": { "timestampFormat": "12-hour" } }\n',
      "12-hour",
    ],
  ] as const)("accepts %s", ([, text, expected]) =>
    inFreshHome(({ prefs, put }) =>
      Effect.gen(function* () {
        yield* put(text);
        assert.equal(Option.getOrThrow(yield* prefs.get).timestampFormat, expected);
      }),
    ),
  );

  it.effect("an empty object is the defaults", () =>
    inFreshHome(({ prefs, put }) =>
      Effect.gen(function* () {
        yield* put("{}\n");
        assert.deepEqual(Option.getOrThrow(yield* prefs.get), yield* fromJson("{}"));
      }),
    ),
  );

  it.effect.each([
    ["broken JSON", "{nope"],
    ["a wrong type", '{"fontSizeCode":"big"}'],
    ["a wrong type inside the old wrapper", '{"settings":{"fontSizeCode":"big"}}'],
  ] as const)("%s is a decode error, not 'no file', and the file is left alone", ([, text]) =>
    inFreshHome(({ prefs, put, file, read }) =>
      Effect.gen(function* () {
        yield* put(text);
        const failure = yield* Effect.flip(prefs.get);
        assert.instanceOf(failure, ShellClientPrefs.ShellClientPrefsReadError);
        assert.deepInclude(failure, { operation: "decode-document", path: file });
        assert.instanceOf(failure.cause, Schema.SchemaError);
        assert.equal(yield* read(), text);
      }),
    ),
  );
});

describe("disk failures", () => {
  it.effect.each(["PermissionDenied", "Unknown"] as const)(
    "a %s read fails without touching the saved file, and a retry succeeds",
    (reason) =>
      inFreshHome(({ prefs, file, disk, read }) =>
        Effect.gen(function* () {
          const saved = { ...customized, onboardingCompletedAt: "2026-10-01T09:00:00.000Z" };
          yield* prefs.set(saved);
          const before = yield* read();
          const cause = PlatformError.systemError({
            _tag: reason,
            module: "FileSystem",
            method: "readFileString",
            pathOrDescriptor: file,
          });
          let broken = true;
          const flaky = yield* ShellClientPrefs.make.pipe(
            Effect.provideService(
              FileSystem.FileSystem,
              FileSystem.FileSystem.of({
                ...disk,
                readFileString: (p) =>
                  Effect.suspend(() => (broken ? Effect.fail(cause) : disk.readFileString(p))),
              }),
            ),
          );
          const failure = yield* Effect.flip(flaky.get);
          assert.instanceOf(failure, ShellClientPrefs.ShellClientPrefsReadError);
          assert.deepInclude(failure, { operation: "read-file", path: file, cause });
          assert.equal(yield* read(), before);
          broken = false;
          assert.deepEqual(Option.getOrThrow(yield* flaky.get), saved);
        }),
      ),
  );

  it.effect("a write that cannot replace the file says which step failed and where", () =>
    inFreshHome(({ prefs, file, disk }) =>
      Effect.gen(function* () {
        yield* disk.makeDirectory(file, { recursive: true }); // a folder where the file should go
        const failure = yield* Effect.flip(prefs.set(customized));
        assert.instanceOf(failure, ShellClientPrefs.ShellClientPrefsWriteError);
        assert.deepInclude(failure, { operation: "replace-settings-file", path: file });
        assert.instanceOf(failure.cause, PlatformError.PlatformError);
        assert.isString(failure.cause.stack);
        assert.equal(
          failure.message,
          `Desktop client settings write failed during replace-settings-file at ${file}.`,
        );
        assert.notInclude(failure.message, failure.cause.message);
      }),
    ),
  );
});
