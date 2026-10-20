import * as Schema from "effect/Schema";

/** One file under a blob's workspace (paths absolute; relPath relative to the workspace root). */
export const WorkspaceFile = Schema.Struct({
  path: Schema.String,
  relPath: Schema.String,
  name: Schema.String,
  sizeBytes: Schema.Number,
  modifiedAt: Schema.Number,
});
export type WorkspaceFile = typeof WorkspaceFile.Type;
