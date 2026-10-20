import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ProjectCommandIcon } from "./chat.ts";
import { ThreadWorkspaceMode } from "./host.ts";

export const KORA_PROJECT_FILE_NAME = "kora.json";

const MAX_ICON_PATH_CHARS = 512;
const MAX_SCRIPTS = 50;

/**
 * Text that is trimmed and must be non-empty after trimming. The documentation
 * hangs on the encoded string so it survives into a generated JSON Schema.
 */
const trimmedNonEmpty = (description: string, maxLength?: number) => {
  const annotated = Schema.String.annotate({ description });
  const encoded =
    maxLength === undefined ? annotated : annotated.check(Schema.isMaxLength(maxLength));
  return encoded.pipe(
    Schema.decodeTo(
      Schema.String.check(Schema.isNonEmpty()),
      SchemaTransformation.transform({
        decode: (value: string) => value.trim(),
        encode: (value: string) => value,
      }),
    ),
  );
};

const describedFlag = (description: string) =>
  Schema.optionalKey(Schema.Boolean.annotate({ description }));

export const KoraProjectFileScript = Schema.Struct({
  name: trimmedNonEmpty("Display name for the script, shown in the Kora scripts menu."),
  command: trimmedNonEmpty("Shell command executed in a Kora terminal at the project root."),
  icon: Schema.optionalKey(
    ProjectCommandIcon.annotate({
      description: `Icon shown next to the script in the scripts menu. Defaults to "play".`,
    }),
  ),
  runOnWorktreeCreate: describedFlag(
    "When true, the script runs automatically after a worktree is created for a new thread.",
  ),
  async: describedFlag(
    "Only for runOnWorktreeCreate scripts. When true (the default), the agent starts while the script is still running. Set false to hold the agent until the script exits.",
  ),
  previewUrl: Schema.optionalKey(
    trimmedNonEmpty(
      "URL opened in the in-app browser preview when this script runs. " +
        "Only honored on the desktop build.",
    ),
  ),
  autoOpenPreview: describedFlag(
    "When true, automatically open the preview panel at `previewUrl` the moment the script starts.",
  ),
}).annotate({ description: "A project script that team members can import into Kora." });
export type KoraProjectFileScript = typeof KoraProjectFileScript.Type;

export const KoraProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'URL of the JSON Schema for this file, typically "https://kora.dev/schema/kora.json".',
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before Kora\'s built-in icon locations.',
      MAX_ICON_PATH_CHARS,
    ),
  ),
  defaultThreadEnvMode: Schema.optionalKey(
    ThreadWorkspaceMode.annotate({
      description:
        'Where new threads start: "worktree" creates a fresh git worktree, "local" uses the current checkout. A per-project setting overrides this; otherwise the global default applies.',
    }),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(KoraProjectFileScript).check(Schema.isMaxLength(MAX_SCRIPTS)).annotate({
      description: "Project scripts shared with everyone who opens this repository in Kora.",
    }),
  ),
}).annotate({
  title: "Kora project file",
  description:
    "Checked-in project configuration for Kora (kora.json at the repository root). See https://kora.dev for documentation.",
});
export type KoraProjectFile = typeof KoraProjectFile.Type;
