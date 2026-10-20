import * as Schema from "effect/Schema";

import { CountingNumber, NonblankString, ThreadId } from "./primitives.ts";

// Only the stacked "commit / push / open PR" action and the command error are
// still reachable; the rest of the git surface left with the git panel.

export const GitStackedAction = Schema.Literals([
  ...(["commit", "push", "create_pr"] as const),
  ...(["commit_push", "commit_push_pr"] as const),
]);
export type GitStackedAction = (typeof GitStackedAction)["Type"];

export const GitRunStackedActionToastRunAction = Schema.Struct({ kind: GitStackedAction });
export type GitRunStackedActionToastRunAction = typeof GitRunStackedActionToastRunAction.Type;

const GitRunStackedActionToastCta = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("open_pr"), label: NonblankString, url: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("run_action"),
    label: NonblankString,
    action: GitRunStackedActionToastRunAction,
  }),
]);
export type GitRunStackedActionToastCta = (typeof GitRunStackedActionToastCta)["Type"];

const GitRunStackedActionToast = Schema.Struct({
  title: NonblankString,
  description: Schema.optionalKey(NonblankString),
  cta: GitRunStackedActionToastCta,
});
export type GitRunStackedActionToast = typeof GitRunStackedActionToast.Type;

export const GitRunStackedActionInput = Schema.Struct({
  actionId: NonblankString,
  cwd: NonblankString,
  action: GitStackedAction,
  commitMessage: Schema.optionalKey(NonblankString.check(Schema.isMaxLength(10_000))),
  featureBranch: Schema.optionalKey(Schema.Boolean),
  filePaths: Schema.optionalKey(Schema.Array(NonblankString).check(Schema.isMinLength(1))),
  /** The thread the action runs beside; a PR it creates is linked to it. */
  threadId: Schema.optionalKey(ThreadId),
});
export type GitRunStackedActionInput = typeof GitRunStackedActionInput.Type;

export const GitRunStackedActionResult = Schema.Struct({
  toast: GitRunStackedActionToast,
  branch: Schema.Struct({
    status: Schema.Literals(["created", "skipped_not_requested"]),
    name: Schema.optionalKey(NonblankString),
  }),
  commit: Schema.Struct({
    status: Schema.Literals(["created", "skipped_no_changes", "skipped_not_requested"]),
    commitSha: Schema.optionalKey(NonblankString),
    subject: Schema.optionalKey(NonblankString),
  }),
  push: Schema.Struct({
    status: Schema.Literals(["pushed", "skipped_not_requested", "skipped_up_to_date"]),
    branch: Schema.optionalKey(NonblankString),
    trackingBranch: Schema.optionalKey(NonblankString),
    setTracking: Schema.optionalKey(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: Schema.Literals(["created", "opened_existing", "skipped_not_requested"]),
    url: Schema.optionalKey(Schema.String),
    number: Schema.optionalKey(CountingNumber),
    baseBranch: Schema.optionalKey(NonblankString),
    headBranch: Schema.optionalKey(NonblankString),
    title: Schema.optionalKey(NonblankString),
  }),
  action: GitStackedAction,
});
export type GitRunStackedActionResult = typeof GitRunStackedActionResult.Type;

const optionalCount = Schema.optional(Schema.Number);

export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
  cause: Schema.optional(Schema.Defect()),
  detail: Schema.String,
  outputLength: optionalCount,
  stderrLength: optionalCount,
  stdoutLength: optionalCount,
  exitCode: optionalCount,
  argumentCount: optionalCount,
  cwd: Schema.String,
  command: Schema.String,
  operation: Schema.String,
}) {
  override get message() {
    return "Git command failed in " + this.operation + " (" + this.cwd + "): " + this.detail;
  }
}
