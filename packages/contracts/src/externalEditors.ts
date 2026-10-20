import * as Schema from "effect/Schema";

import { NonblankString } from "./primitives.ts";

/** How a file/line target is handed to the editor's command line. */
export const EditorLaunchStyle = Schema.Literals(["direct-path", "goto", "line-column"]);
export type EditorLaunchStyle = typeof EditorLaunchStyle.Type;

interface EditorDefinition {
  /** URL scheme of the editor's SSH-remote deep link (`<scheme>://vscode-remote/ssh-remote+<host><path>`; Zed uses `zed://ssh/<host><path>`). */
  readonly remoteScheme?: string;
  readonly launchStyle: EditorLaunchStyle;
  readonly baseArgs?: readonly string[];
  readonly commands: readonly [string, ...string[]] | null;
  readonly label: string;
  readonly id: string;
}

// Menu order. The JetBrains family takes line and column as separate arguments.
export const EDITORS = [
  {
    remoteScheme: "cursor",
    launchStyle: "goto",
    // File and workspace opens must reach the IDE even when the Agents Window is active.
    baseArgs: ["--classic"],
    commands: ["cursor"],
    label: "Cursor",
    id: "cursor",
  },
  { launchStyle: "goto", commands: ["trae"], label: "Trae", id: "trae" },
  { launchStyle: "goto", commands: ["kiro"], baseArgs: ["ide"], label: "Kiro", id: "kiro" },
  {
    remoteScheme: "vscode",
    launchStyle: "goto",
    commands: ["code"],
    label: "VS Code",
    id: "vscode",
  },
  {
    remoteScheme: "vscode-insiders",
    launchStyle: "goto",
    commands: ["code-insiders"],
    label: "VS Code Insiders",
    id: "vscode-insiders",
  },
  {
    remoteScheme: "vscodium",
    launchStyle: "goto",
    commands: ["codium"],
    label: "VSCodium",
    id: "vscodium",
  },
  {
    remoteScheme: "zed",
    launchStyle: "direct-path",
    commands: ["zed", "zeditor"],
    label: "Zed",
    id: "zed",
  },
  { launchStyle: "goto", commands: ["agy"], label: "Antigravity", id: "antigravity" },
  { launchStyle: "line-column", commands: ["idea"], label: "IntelliJ IDEA", id: "idea" },
  { launchStyle: "line-column", commands: ["aqua"], label: "Aqua", id: "aqua" },
  { launchStyle: "line-column", commands: ["clion"], label: "CLion", id: "clion" },
  { launchStyle: "line-column", commands: ["datagrip"], label: "DataGrip", id: "datagrip" },
  { launchStyle: "line-column", commands: ["dataspell"], label: "DataSpell", id: "dataspell" },
  { launchStyle: "line-column", commands: ["goland"], label: "GoLand", id: "goland" },
  { launchStyle: "line-column", commands: ["phpstorm"], label: "PhpStorm", id: "phpstorm" },
  { launchStyle: "line-column", commands: ["pycharm"], label: "PyCharm", id: "pycharm" },
  { launchStyle: "line-column", commands: ["rider"], label: "Rider", id: "rider" },
  { launchStyle: "line-column", commands: ["rubymine"], label: "RubyMine", id: "rubymine" },
  { launchStyle: "line-column", commands: ["rustrover"], label: "RustRover", id: "rustrover" },
  { launchStyle: "line-column", commands: ["webstorm"], label: "WebStorm", id: "webstorm" },
  { launchStyle: "direct-path", commands: null, label: "File Manager", id: "file-manager" },
] as const satisfies ReadonlyArray<EditorDefinition>;

export const ExternalEditorId = Schema.Literals(EDITORS.map((editor) => editor.id));
export type ExternalEditorId = typeof ExternalEditorId.Type;

export const RevealInFinderKind = Schema.Literals(["finder", "file-explorer", "files"]);
export type RevealInFinderKind = typeof RevealInFinderKind.Type;

export const LaunchEditorInput = Schema.Struct({
  cwd: NonblankString,
  editor: ExternalEditorId,
  /** Select `cwd` in the file manager instead of opening it. Only the "file-manager" editor honours it. */
  reveal: Schema.optionalKey(Schema.Boolean),
});
export type LaunchEditorInput = typeof LaunchEditorInput.Type;

export const remoteSchemeForEditor = (id: ExternalEditorId): string | undefined =>
  (EDITORS.find((editor) => editor.id === id) as EditorDefinition | undefined)?.remoteScheme;

/** Editors that can open an SSH-remote deep link. */
export const REMOTE_CAPABLE_EDITOR_IDS: ReadonlyArray<ExternalEditorId> = EDITORS.filter(
  (editor) => "remoteScheme" in editor,
).map((editor) => editor.id);

export const RemoteOpenTargetKind = Schema.Literals(["tailscale", "mdns"]);
export type RemoteOpenTargetKind = (typeof RemoteOpenTargetKind)["Type"];

/** An SSH hostname this environment advertises (tailnet name first, then `<hostname>.local`). */
export const RemoteOpenTarget = Schema.Struct({
  kind: RemoteOpenTargetKind,
  host: NonblankString,
});
export type RemoteOpenTarget = typeof RemoteOpenTarget.Type;

const spawnLine = (command: string, args: ReadonlyArray<string>) => [command, ...args].join(" ");

export class ExternalLauncherUnknownEditorError extends Schema.TaggedError<ExternalLauncherUnknownEditorError>()(
  "ExternalLauncherUnknownEditorError",
  { editor: Schema.String },
) {
  override get message() {
    return "Unknown editor: " + this.editor;
  }
}

export class ExternalLauncherUnsupportedEditorError extends Schema.TaggedError<ExternalLauncherUnsupportedEditorError>()(
  "ExternalLauncherUnsupportedEditorError",
  { editor: ExternalEditorId },
) {
  override get message() {
    return "Unsupported editor: " + this.editor;
  }
}

export class ExternalLauncherCommandNotFoundError extends Schema.TaggedError<ExternalLauncherCommandNotFoundError>()(
  "ExternalLauncherCommandNotFoundError",
  { editor: ExternalEditorId, command: Schema.String },
) {
  override get message() {
    return `Editor command not found: ${this.command}`;
  }
}

export class ExternalLauncherBrowserSpawnError extends Schema.TaggedError<ExternalLauncherBrowserSpawnError>()(
  "ExternalLauncherBrowserSpawnError",
  {
    target: Schema.String,
    cause: Schema.Defect(),
    args: Schema.Array(Schema.String),
    command: Schema.String,
  },
) {
  override get message() {
    return `Failed to launch browser target '${this.target}' with '${spawnLine(this.command, this.args)}'`;
  }
}

export class ExternalLauncherEditorSpawnError extends Schema.TaggedError<ExternalLauncherEditorSpawnError>()(
  "ExternalLauncherEditorSpawnError",
  {
    target: Schema.String,
    editor: ExternalEditorId,
    cause: Schema.Defect(),
    args: Schema.Array(Schema.String),
    command: Schema.String,
  },
) {
  override get message() {
    return `Failed to launch '${this.target}' in ${this.editor} with '${spawnLine(this.command, this.args)}'`;
  }
}

const SPAWN_LAUNCHER_ERRORS = [
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherEditorSpawnError,
] as const;
export const ExternalLauncherError = Schema.Union([
  ...SPAWN_LAUNCHER_ERRORS,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherUnsupportedEditorError,
  ExternalLauncherUnknownEditorError,
]);
export type ExternalLauncherError = (typeof ExternalLauncherError)["Type"];
