import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import * as ShellContext from "./ShellContext.ts";
import * as ShellAssets from "./ShellAssets.ts";
import * as NativeApp from "../native/NativeApp.ts";

export class ShellUserDataPathResolutionError extends Schema.TaggedError<ShellUserDataPathResolutionError>()(
  "ShellUserDataPathResolutionError",
  { legacyPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to inspect legacy desktop user-data path at "${this.legacyPath}".`;
  }
}

export class ShellAppIdentity extends Context.Service<
  ShellAppIdentity,
  {
    /** Where Electron keeps this app's user data. */
    readonly resolveUserDataPath: Effect.Effect<string, ShellUserDataPathResolutionError>;
    /** Name, About panel and dock icon; safe to run before and after the app is ready. */
    readonly configure: Effect.Effect<void>;
  }
>()("@kora/desktop/app/ShellAppIdentity") {}

const PackageManifest = Schema.Struct({ koraCommitHash: Schema.optional(Schema.String) });
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(PackageManifest));

const HEX_HASH = /^[0-9a-f]{7,40}$/;
/** 7–40 hex digits, any case, shown lowercased and cut to 12 characters; anything else is no hash. */
const normalizeCommitHash = (raw: string): Option.Option<string> =>
  Option.liftPredicate(raw.trim().toLowerCase(), (h) => HEX_HASH.test(h)).pipe(
    Option.map((h) => h.slice(0, 12)),
  );

const make = Effect.gen(function* () {
  const assets = yield* ShellAssets.ShellAssets;
  const nativeApp = yield* NativeApp.NativeApp;
  const envVars = yield* ShellContext.ShellContext;
  const fsys = yield* FileSystem.FileSystem;

  const inAppData = (dir: string) => envVars.path.join(envVars.appDataDirectory, dir);

  // An install that already has the old folder keeps using it, whatever the folder is called today.
  const resolveUserDataPath = Effect.suspend(() => {
    const legacyPath = inAppData(envVars.legacyUserDataDirName);
    return fsys.exists(legacyPath).pipe(
      Effect.map((kept) => (kept ? legacyPath : inAppData(envVars.userDataDirName))),
      Effect.mapError((cause) => new ShellUserDataPathResolutionError({ legacyPath, cause })),
    );
  });

  /** The bundled package.json's commit hash (packaged builds only). */
  const bundledCommitHash = fsys
    .readFileString(envVars.path.join(envVars.appRoot, "package.json"))
    .pipe(
      Effect.map((text) =>
        decodeManifest(text).pipe(
          Option.flatMap((m) => Option.fromNullishOr(m.koraCommitHash)),
          Option.flatMap(normalizeCommitHash),
        ),
      ),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  // KORA_COMMIT_HASH wins; an unpackaged run has no bundle to read.
  const lookUpCommitHash = Effect.suspend(() => {
    const override = Option.flatMap(envVars.commitHashOverride, normalizeCommitHash);
    if (Option.isSome(override)) return Effect.succeed(override);
    return envVars.isPackaged ? bundledCommitHash : Effect.succeed(Option.none<string>());
  });
  // The answer, including "none", is looked up once per service.
  const commitHash = yield* Effect.cached(lookUpCommitHash);

  const configure = Effect.gen(function* () {
    const hash = yield* commitHash;
    yield* nativeApp.setName(envVars.displayName);
    yield* nativeApp.setAboutPanelOptions({
      applicationName: envVars.displayName,
      applicationVersion: envVars.appVersion,
      version: Option.getOrElse(hash, () => "unknown"),
    });
    // A bundle already carries its icon (and a custom one the user applied); only an unpackaged run needs it set.
    if (envVars.platform === "darwin" && !envVars.isPackaged) {
      const icons = yield* assets.iconPaths;
      if (Option.isSome(icons.png)) yield* nativeApp.setDockIcon(icons.png.value);
    }
  }).pipe(Effect.withSpan("shell.appIdentity.configure"));

  return ShellAppIdentity.of({ resolveUserDataPath, configure });
});

export const layer = Layer.effect(ShellAppIdentity, make);
