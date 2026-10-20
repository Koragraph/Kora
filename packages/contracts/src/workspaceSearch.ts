import * as Schema from "effect/Schema";

import { CountingNumber, NonblankString, TrimmedString, WholeNumber } from "./primitives.ts";

const FIND_MAX_LIMIT = 200;
const GREP_MAX_LIMIT = 500;
const QUERY_MAX_CHARS = 256;
const RELATIVE_PATH_MAX_CHARS = 512;

export const ProjectEntryKind = Schema.Literals(["file", "directory"]);
export type ProjectEntryKind = typeof ProjectEntryKind.Type;

export const WorkspaceFindInput = Schema.Struct({
  cwd: NonblankString,
  // An empty query is a bounded, frecency-ordered browse (the file picker's first results).
  query: TrimmedString.check(Schema.isMaxLength(QUERY_MAX_CHARS)),
  limit: CountingNumber.check(Schema.isLessThanOrEqualTo(FIND_MAX_LIMIT)),
  kind: Schema.optionalKey(ProjectEntryKind),
  imageOnly: Schema.optionalKey(Schema.Boolean),
});
export type WorkspaceFindInput = typeof WorkspaceFindInput.Type;

export const WorkspaceEntry = Schema.Struct({
  path: NonblankString,
  kind: ProjectEntryKind,
  ignored: Schema.optionalKey(Schema.Boolean),
});
export type WorkspaceEntry = typeof WorkspaceEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(WorkspaceEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const WorkspaceGrepInput = Schema.Struct({
  cwd: NonblankString,
  // Deliberately not trimmed: leading/trailing spaces are part of the pattern.
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(QUERY_MAX_CHARS)),
  limit: CountingNumber.check(Schema.isLessThanOrEqualTo(GREP_MAX_LIMIT)),
  useRegex: Schema.Boolean,
  wholeWord: Schema.Boolean,
  caseSensitive: Schema.Boolean,
});
export type WorkspaceGrepInput = typeof WorkspaceGrepInput.Type;

export const ProjectContentMatchRange = Schema.Struct({ start: WholeNumber, end: WholeNumber });
export type ProjectContentMatchRange = typeof ProjectContentMatchRange.Type;

export const ProjectContentMatch = Schema.Struct({
  path: NonblankString,
  lineNumber: CountingNumber,
  matchRanges: Schema.Array(ProjectContentMatchRange),
  lineContent: Schema.String,
});
export type ProjectContentMatch = (typeof ProjectContentMatch)["Type"];

export const ProjectSearchContentsResult = Schema.Struct({
  truncated: Schema.Boolean,
  matches: Schema.Array(ProjectContentMatch),
  regexFallbackError: Schema.optionalKey(Schema.String),
});
export type ProjectSearchContentsResult = typeof ProjectSearchContentsResult.Type;

export const ProjectListEntriesInput = Schema.Struct({
  cwd: NonblankString,
  // Present: the immediate children (ignored ones included; "" is the root).
  // Omitted: the indexed recursive listing older clients rely on.
  directoryPath: Schema.optionalKey(TrimmedString),
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const WorkspaceListResult = Schema.Struct({
  entries: Schema.Array(WorkspaceEntry),
  truncated: Schema.Boolean,
});
export type WorkspaceListResult = typeof WorkspaceListResult.Type;

const WORKSPACE_ROOT_FAILURES = [
  ...(["workspace_root_not_found", "workspace_root_create_failed"] as const),
  ...(["workspace_root_stat_failed", "workspace_root_not_directory"] as const),
] as const;
const SEARCH_INDEX_FAILURES = [
  "search_index_create_failed",
  ...(["search_index_scan_timed_out", "search_index_search_failed"] as const),
] as const;
export const ProjectEntriesFailure = Schema.Literals([
  ...WORKSPACE_ROOT_FAILURES,
  ...SEARCH_INDEX_FAILURES,
  "directory_list_failed",
]);
export type ProjectEntriesFailure = (typeof ProjectEntriesFailure)["Type"];

const PATH_ESCAPE_FAILURES = ["workspace_path_outside_root", "resolved_path_outside_root"] as const;
export const ProjectFileFailure = Schema.Literals([
  ...PATH_ESCAPE_FAILURES,
  ...(["path_not_file", "binary_file", "operation_failed"] as const),
]);
export type ProjectFileFailure = (typeof ProjectFileFailure)["Type"];

const REALPATH_OPERATIONS = ["realpath-workspace-root", "realpath-target"] as const;
export const ProjectFileOperation = Schema.Literals([
  ...REALPATH_OPERATIONS,
  ...(["open", "stat", "read", "close"] as const),
  ...(["make-directory", "write-file"] as const),
]);
export type ProjectFileOperation = (typeof ProjectFileOperation)["Type"];

// Errors. Every structured field is optional on the wire so a newer peer can still decode a
// message-only failure from an older one. In code, the constructor takes the request context
// and writes `message` itself unless the props already carry one.

const withDefaultMessage = <P extends { readonly message?: unknown }>(
  props: P,
  fallback: string,
): P & { readonly message: string } => ({
  ...props,
  message: typeof props.message === "string" ? props.message : fallback,
});

const searchErrorFields = {
  cwd: Schema.optionalKey(Schema.String),
  queryLength: Schema.optionalKey(WholeNumber),
  limit: Schema.optionalKey(CountingNumber),
  failure: Schema.optionalKey(ProjectEntriesFailure),
  normalizedCwd: Schema.optionalKey(NonblankString),
  timeout: Schema.optionalKey(NonblankString),
  detail: Schema.optionalKey(NonblankString),
  message: NonblankString,
  cause: Schema.optionalKey(Schema.Defect()),
};

interface SearchErrorProps {
  readonly cwd?: string;
  readonly queryLength?: number;
  readonly limit?: number;
  readonly failure?: ProjectEntriesFailure;
  readonly cause?: unknown;
  readonly message?: string;
  readonly detail?: string;
  readonly timeout?: string;
  readonly normalizedCwd?: string;
}

export class WorkspaceFindError extends Schema.TaggedError<WorkspaceFindError>()(
  "WorkspaceFindError",
  searchErrorFields,
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off -- context-object construction with a default message
  constructor(props: SearchErrorProps, options?: Schema.MakeOptions) {
    super(
      withDefaultMessage(props, `Failed to search workspace entries in '${props.cwd}'.`) as never,
      options,
    );
  }
}

export class WorkspaceGrepError extends Schema.TaggedError<WorkspaceGrepError>()(
  "WorkspaceGrepError",
  searchErrorFields,
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off -- context-object construction with a default message
  constructor(props: SearchErrorProps, options?: Schema.MakeOptions) {
    super(
      withDefaultMessage(props, `Failed to search workspace contents in '${props.cwd}'.`) as never,
      options,
    );
  }
}

export class WorkspaceListError extends Schema.TaggedError<WorkspaceListError>()(
  "WorkspaceListError",
  {
    cwd: Schema.optionalKey(Schema.String),
    failure: Schema.optionalKey(ProjectEntriesFailure),
    normalizedCwd: Schema.optionalKey(NonblankString),
    timeout: Schema.optionalKey(NonblankString),
    detail: Schema.optionalKey(NonblankString),
    message: NonblankString,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off -- context-object construction with a default message
  constructor(
    props: Omit<SearchErrorProps, "queryLength" | "limit">,
    options?: Schema.MakeOptions,
  ) {
    super(
      withDefaultMessage(props, `Failed to list workspace entries in '${props.cwd}'.`) as never,
      options,
    );
  }
}

export const ProjectReadFileInput = Schema.Struct({
  cwd: NonblankString,
  // Workspace-relative, or an absolute host path for a file outside the workspace.
  // Only workspace-relative paths can be written back.
  relativePath: NonblankString.check(Schema.isMaxLength(RELATIVE_PATH_MAX_CHARS)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const WorkspaceFileReadResult = Schema.Struct({
  relativePath: NonblankString,
  contents: Schema.String,
  byteLength: WholeNumber,
  truncated: Schema.Boolean,
});
export type WorkspaceFileReadResult = typeof WorkspaceFileReadResult.Type;

const fileErrorFields = {
  cwd: Schema.optionalKey(Schema.String),
  relativePath: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(ProjectFileFailure),
  resolvedPath: Schema.optionalKey(NonblankString),
  resolvedWorkspaceRoot: Schema.optionalKey(NonblankString),
  operation: Schema.optionalKey(ProjectFileOperation),
  operationPath: Schema.optionalKey(NonblankString),
  message: NonblankString,
  cause: Schema.optionalKey(Schema.Defect()),
};

interface FileErrorProps {
  readonly cwd?: string;
  readonly relativePath?: string;
  readonly failure?: ProjectFileFailure;
  readonly cause?: unknown;
  readonly message?: string;
  readonly operationPath?: string;
  readonly operation?: ProjectFileOperation;
  readonly resolvedWorkspaceRoot?: string;
  readonly resolvedPath?: string;
}

export class WorkspaceFileReadError extends Schema.TaggedError<WorkspaceFileReadError>()(
  "WorkspaceFileReadError",
  fileErrorFields,
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off -- context-object construction with a default message
  constructor(props: FileErrorProps, options?: Schema.MakeOptions) {
    super(
      withDefaultMessage(
        props,
        `Failed to read workspace file '${props.relativePath}' in '${props.cwd}'.`,
      ) as never,
      options,
    );
  }
}

export class WorkspaceFileWriteError extends Schema.TaggedError<WorkspaceFileWriteError>()(
  "WorkspaceFileWriteError",
  fileErrorFields,
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off -- context-object construction with a default message
  constructor(props: FileErrorProps, options?: Schema.MakeOptions) {
    super(
      withDefaultMessage(
        props,
        `Failed to write workspace file '${props.relativePath}' in '${props.cwd}'.`,
      ) as never,
      options,
    );
  }
}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: NonblankString,
  relativePath: NonblankString.check(Schema.isMaxLength(RELATIVE_PATH_MAX_CHARS)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({ relativePath: NonblankString });
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;
