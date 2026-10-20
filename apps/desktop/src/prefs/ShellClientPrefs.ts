import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import { parseLenientJson } from "@kora/shared/lenientJson";
import { ClientPrefsSchema, migrateLegacyClientPrefsKeys, type ClientPrefs } from "@kora/contracts";

import { readStateFileString } from "./legacyStateFiles.ts";
import * as ShellContext from "../app/ShellContext.ts";

export class ShellClientPrefsReadError extends Schema.TaggedError<ShellClientPrefsReadError>()(
  "ShellClientPrefsReadError",
  {
    cause: Schema.Defect(),
    path: Schema.String,
    operation: Schema.Literals(["read-file", "decode-document"]),
  },
) {
  override get message() {
    return `Desktop client settings read failed during ${this.operation} at ${this.path}.`;
  }
}

export class ShellClientPrefsWriteError extends Schema.TaggedError<ShellClientPrefsWriteError>()(
  "ShellClientPrefsWriteError",
  {
    cause: Schema.Defect(),
    path: Schema.String,
    operation: Schema.Literals([
      "write-temporary-file",
      "replace-settings-file",
      "create-temporary-file-name",
      "create-directory",
      "encode-document",
    ]),
  },
) {
  override get message() {
    return `Desktop client settings write failed during ${this.operation} at ${this.path}.`;
  }
}

export class ShellClientPrefs extends Context.Service<
  ShellClientPrefs,
  {
    readonly get: Effect.Effect<Option.Option<ClientPrefs>, ShellClientPrefsReadError>;
    readonly set: (conf: ClientPrefs) => Effect.Effect<void, ShellClientPrefsWriteError>;
  }
>()("@kora/desktop/prefs/ShellClientPrefs") {}

const decodeAnyDocument = Schema.decodeUnknownEffect(
  parseLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodePrefs = Schema.decodeUnknownEffect(ClientPrefsSchema);
const encodePrefs = Schema.encodeEffect(parseLenientJson(ClientPrefsSchema));

export const make = Effect.gen(function* () {
  const envVars = yield* ShellContext.ShellContext;
  const fsys = yield* FileSystem.FileSystem;
  const loc = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const filePath = envVars.clientSettingsPath;

  const readText = readStateFileString(fsys, filePath).pipe(
    Effect.map(Option.some),
    Effect.catchTag("PlatformError", (cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeedNone
        : Effect.logWarning("Could not read desktop client settings.", cause).pipe(
            Effect.annotateLogs({ settingsPath: filePath }),
            Effect.andThen(
              Effect.fail(
                new ShellClientPrefsReadError({ operation: "read-file", path: filePath, cause }),
              ),
            ),
          ),
    ),
  );

  const decodeText = (str: string) =>
    Effect.gen(function* () {
      const document = yield* decodeAnyDocument(str);
      // The older nested shape wraps everything in "settings". Choose before validating so bad legacy content is
      // reported instead of quietly becoming defaults.
      const effective = "settings" in document ? document.settings : document;
      return yield* decodePrefs(migrateLegacyClientPrefsKeys(effective));
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Could not decode desktop client settings.", cause).pipe(
          Effect.annotateLogs({ settingsPath: filePath }),
        ),
      ),
      Effect.mapError(
        (cause) =>
          new ShellClientPrefsReadError({ operation: "decode-document", path: filePath, cause }),
      ),
    );

  const get = Effect.gen(function* () {
    const str = yield* readText;
    if (Option.isNone(str)) return Option.none<ClientPrefs>();
    return Option.some(yield* decodeText(str.value));
  }).pipe(Effect.withSpan("shell.clientSettings.get"));

  const failWrite =
    (operation1: ShellClientPrefsWriteError["operation"], when: string) => (cause: unknown) =>
      new ShellClientPrefsWriteError({ operation: operation1, path: when, cause });

  const bag = Effect.fn("shell.clientSettings.set")(function* (conf: ClientPrefs) {
    const ident = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(failWrite("create-temporary-file-name", filePath)),
    );
    const str = yield* encodePrefs(conf).pipe(
      Effect.mapError(failWrite("encode-document", filePath)),
    );
    const temporary = `${filePath}.${process.pid}.${ident.replaceAll("-", "")}.tmp`;
    yield* fsys
      .makeDirectory(loc.dirname(filePath), { recursive: true })
      .pipe(Effect.mapError(failWrite("create-directory", loc.dirname(filePath))));
    yield* fsys
      .writeFileString(temporary, `${str}\n`)
      .pipe(Effect.mapError(failWrite("write-temporary-file", temporary)));
    yield* fsys
      .rename(temporary, filePath)
      .pipe(Effect.mapError(failWrite("replace-settings-file", filePath)));
  });

  return ShellClientPrefs.of({ get, set: bag });
});

export const layer = Layer.effect(ShellClientPrefs, make);
