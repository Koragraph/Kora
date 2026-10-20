import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import * as ShellContext from "./ShellContext.ts";

export interface ShellIconPaths {
  readonly png: Option.Option<string>;
  readonly icns: Option.Option<string>;
  readonly ico: Option.Option<string>;
}

export class ShellAssetProbeError extends Schema.TaggedError<ShellAssetProbeError>()(
  "ShellAssetProbeError",
  {
    cause: Schema.Defect(),
    candidatePath: Schema.String,
    fileName: Schema.String,
  },
) {
  override get message() {
    return `Failed to probe desktop asset "${this.fileName}" at ${this.candidatePath}.`;
  }
}

export class ShellAssets extends Context.Service<
  ShellAssets,
  {
    readonly iconPaths: Effect.Effect<ShellIconPaths>;
    readonly resolveResourcePath: (
      baseName: string,
    ) => Effect.Effect<Option.Option<string>, ShellAssetProbeError>;
  }
>()("@kora/desktop/app/ShellAssets") {}

type IconExtension = "ico" | "icns" | "png";

/** File inside <repo>/assets/icons/<flavor>/ for each icon kind (see scripts/brand/make-icons.py). */
const sourceIconFile = (extension: Exclude<IconExtension, "icns">, platform: string): string =>
  extension === "ico" ? "windows.ico" : platform === "darwin" ? "mac-1024.png" : "square-1024.png";

const make = Effect.gen(function* () {
  const fsys = yield* FileSystem.FileSystem;
  const envVars = yield* ShellContext.ShellContext;

  const resolveResourcePath = (baseName: string) =>
    Effect.gen(function* () {
      for (const candidatePath of envVars.resolveResourcePathCandidates(baseName)) {
        const present = yield* fsys
          .exists(candidatePath)
          .pipe(
            Effect.mapError(
              (reason) =>
                new ShellAssetProbeError({ fileName: baseName, candidatePath, cause: reason }),
            ),
          );
        if (present) return Option.some(candidatePath);
      }
      return Option.none<string>();
    });

  const sourceTreeIcon = (extension: IconExtension): string | null => {
    // Packaged builds and icns never come from the source tree.
    if (envVars.isPackaged || extension === "icns") return null;
    const flavor = envVars.isDevelopment ? "checkout" : "release";
    return envVars.path.join(
      envVars.rootDir,
      "assets",
      "icons",
      flavor,
      sourceIconFile(extension, envVars.platform),
    );
  };

  const resolveIcon = (extension: IconExtension) =>
    Effect.gen(function* () {
      const fromSource = sourceTreeIcon(extension);
      if (
        fromSource !== null &&
        (yield* fsys.exists(fromSource).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return Option.some(fromSource);
      }
      return yield* resolveResourcePath(`icon.${extension}`);
    });

  // Probed once at startup; a failing probe surfaces when the layer is built.
  const [ico, icns, png] = yield* Effect.all(
    [resolveIcon("ico"), resolveIcon("icns"), resolveIcon("png")],
    { concurrency: "unbounded" },
  );

  return ShellAssets.of({
    iconPaths: Effect.succeed({ ico, icns, png }),
    resolveResourcePath,
  });
});

export const layer = Layer.effect(ShellAssets, make);
