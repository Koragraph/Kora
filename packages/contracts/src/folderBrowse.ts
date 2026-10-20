import * as Schema from "effect/Schema";
import { NonblankString } from "./primitives.ts";

const FILESYSTEM_PATH_MAX_LENGTH = 512;

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: NonblankString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(NonblankString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: NonblankString,
  fullPath: NonblankString,
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  entries: Schema.Array(FilesystemBrowseEntry),
  parentPath: NonblankString,
});
export type FilesystemBrowseResult = (typeof FilesystemBrowseResult)["Type"];

export const FilesystemBrowseFailure = Schema.Literals([
  "windows_path_unsupported",
  ...(["current_project_required", "read_directory_failed"] as const),
]);
export type FilesystemBrowseFailure = (typeof FilesystemBrowseFailure)["Type"];

const decodedFilesystemBrowseErrorMessage = (props: object): string | undefined => {
  const carried = "message" in props ? props.message : undefined;
  return typeof carried === "string" ? carried : undefined;
};

export class HostFsBrowseError extends Schema.TaggedError<HostFsBrowseError>()(
  "HostFsBrowseError",
  {
    partialPath: Schema.optional(NonblankString),
    cwd: Schema.optional(NonblankString),
    failure: Schema.optional(FilesystemBrowseFailure),
    parentPath: Schema.optional(NonblankString),
    platform: Schema.optional(NonblankString),
    message: NonblankString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // Structured diagnostics stay optional for rolling compatibility with legacy message-only
  // payloads, while new call sites must provide the request context and failure classification.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly cause?: unknown;
    readonly platform?: string;
    readonly parentPath?: string;
    readonly failure: FilesystemBrowseFailure;
    readonly cwd?: string | undefined;
    readonly partialPath: string;
  }) {
    const origin = props.cwd === undefined ? "" : " from '" + props.cwd + "'";
    const fallback = "Failed to browse filesystem path '" + props.partialPath + "'" + origin + ".";
    super({ ...props, message: decodedFilesystemBrowseErrorMessage(props) ?? fallback } as any);
  }
}
