import * as Schema from "effect/Schema";
import { NonblankString } from "./primitives.ts";
import { GitCommandError } from "./gitActions.ts";
import { ScmError } from "./scmDriver.ts";

export const ReviewDiffViewInput = Schema.Struct({
  cwd: NonblankString,
  baseRef: Schema.optional(NonblankString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffViewInput = typeof ReviewDiffViewInput.Type;

export const ReviewDiffViewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffViewSourceKind = typeof ReviewDiffViewSourceKind.Type;

export const ReviewDiffViewSource = Schema.Struct({
  id: NonblankString,
  kind: ReviewDiffViewSourceKind,
  title: NonblankString,
  baseRef: Schema.NullOr(NonblankString),
  headRef: Schema.NullOr(NonblankString),
  diff: Schema.String,
  diffHash: NonblankString,
  truncated: Schema.Boolean,
});
export type ReviewDiffViewSource = typeof ReviewDiffViewSource.Type;

export const ReviewDiffFileContentsInput = Schema.Struct({
  cwd: NonblankString,
  sourceKind: ReviewDiffViewSourceKind,
  changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  baseRef: Schema.NullOr(NonblankString),
  headRef: Schema.NullOr(NonblankString),
  oldPath: NonblankString,
  newPath: NonblankString,
});
export type ReviewDiffFileContentsInput = (typeof ReviewDiffFileContentsInput)["Type"];

export const ReviewDiffFileContentsResult = Schema.Struct({
  newContents: Schema.String,
  oldContents: Schema.String,
});
export type ReviewDiffFileContentsResult = (typeof ReviewDiffFileContentsResult)["Type"];

export const ReviewDiffViewResult = Schema.Struct({
  cwd: NonblankString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffViewSource),
});
export type ReviewDiffViewResult = typeof ReviewDiffViewResult.Type;

export const ReviewDiffViewError = Schema.Union([ScmError, GitCommandError]);
export type ReviewDiffViewError = typeof ReviewDiffViewError.Type;
