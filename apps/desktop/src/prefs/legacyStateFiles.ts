import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

/**
 * Desktop state files renamed on 2026-10-02 (new name → the name earlier builds wrote). A reader that finds no
 * file under the new name reads the old one; the next write creates the new file, after which the old one is
 * never read again. Nothing is deleted, so a downgrade still finds its file.
 */
const LEGACY_STATE_FILE_NAMES: Readonly<Record<string, string>> = {
  "shell-prefs.json": "desktop-settings.json",
  "client-prefs.json": "client-settings.json",
};

/** The pre-rename path of a state file, or undefined when its name was never changed. */
export function legacyStateFilePath(filePath: string): string | undefined {
  const match = /^(.*[\\/])?([^\\/]+)$/.exec(filePath);
  if (!match) return undefined;
  const legacyName = LEGACY_STATE_FILE_NAMES[match[2]!];
  return legacyName === undefined ? undefined : `${match[1] ?? ""}${legacyName}`;
}

/** `readFileString` that falls back to the file's pre-rename path when the current one does not exist. */
export const readStateFileString = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.readFileString(filePath).pipe(
    Effect.catchTag("PlatformError", (cause) => {
      const legacyPath = legacyStateFilePath(filePath);
      return cause.reason._tag === "NotFound" && legacyPath !== undefined
        ? fileSystem.readFileString(legacyPath)
        : Effect.fail(cause);
    }),
  );
