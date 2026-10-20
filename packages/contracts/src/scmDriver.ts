import * as Schema from "effect/Schema";

import { WholeNumber } from "./primitives.ts";

export const ScmDriverKind = Schema.Literals(["git", "jj", "unknown"]);
export type ScmDriverKind = Schema.Schema.Type<typeof ScmDriverKind>;

/** Where and what a failed VCS process ran. */
export type ScmProcessErrorContext = Readonly<
  Record<"operation" | "command" | "cwd", string> & { argumentCount?: number }
>;

export type ScmProcessSpawnFailure = { readonly cause: unknown };
export type ScmProcessTimeoutFailure = { readonly timeoutMs: number };

export interface ScmProcessExitFailure {
  readonly stderrTruncated: boolean;
  readonly stderr: string;
  readonly exitCode: number;
}

export const ScmProcessExitFailureKind = Schema.Literals([
  ...(["authentication", "not-found"] as const),
  ...(["rate-limited", "command-failed"] as const),
]);
export type ScmProcessExitFailureKind = (typeof ScmProcessExitFailureKind)["Type"];

// Fields every process failure carries so the log says what ran and where.
const processFields = {
  argumentCount: Schema.optional(WholeNumber),
  cwd: Schema.String,
  command: Schema.String,
  operation: Schema.String,
};

const describeExit = (command: string, kind: ScmProcessExitFailureKind): string => {
  switch (kind) {
    case "authentication":
      return "Authentication failed.";
    case "rate-limited":
      return "API rate limit exceeded.";
    case "not-found":
      if (command === "glab") return "Merge request not found.";
      return command === "gh" || command === "az"
        ? "Pull request not found."
        : "VCS resource not found.";
    default:
      return "Process exited with a non-zero status.";
  }
};

export class ScmProcessSpawnError extends Schema.TaggedError<ScmProcessSpawnError>()(
  "ScmProcessSpawnError",
  { ...processFields, cause: Schema.Defect() },
) {
  static fromProcessSpawnError(
    context: ScmProcessErrorContext,
    failure: ScmProcessSpawnFailure,
  ): ScmProcessSpawnError {
    return new ScmProcessSpawnError({ ...context, cause: failure.cause });
  }

  override get message() {
    return `VCS process failed to spawn in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export class ScmProcessExitError extends Schema.TaggedError<ScmProcessExitError>()(
  "ScmProcessExitError",
  {
    ...processFields,
    exitCode: Schema.Number,
    detail: Schema.String,
    failureKind: Schema.optional(ScmProcessExitFailureKind),
    stderrLength: Schema.optional(WholeNumber),
    stderrTruncated: Schema.optional(Schema.Boolean),
  },
) {
  /** Only the length of stderr is kept, never its text. */
  static fromProcessExit(
    context: ScmProcessErrorContext,
    failure: ScmProcessExitFailure,
    failureKind: ScmProcessExitFailureKind,
  ): ScmProcessExitError {
    return new ScmProcessExitError({
      ...context,
      exitCode: failure.exitCode,
      detail: describeExit(context.command, failureKind),
      failureKind,
      stderrLength: failure.stderr.length,
      stderrTruncated: failure.stderrTruncated,
    });
  }

  override get message() {
    return `VCS process failed in ${this.operation}: ${this.command} (${this.cwd}) exited with ${this.exitCode} - ${this.detail}`;
  }
}

export class ScmProcessTimeoutError extends Schema.TaggedError<ScmProcessTimeoutError>()(
  "ScmProcessTimeoutError",
  { ...processFields, timeoutMs: Schema.Number },
) {
  static fromProcessTimeoutError(
    context: ScmProcessErrorContext,
    failure: ScmProcessTimeoutFailure,
  ): ScmProcessTimeoutError {
    return new ScmProcessTimeoutError({ ...context, timeoutMs: failure.timeoutMs });
  }

  override get message() {
    return `VCS process timed out in ${this.operation}: ${this.command} (${this.cwd}) after ${this.timeoutMs}ms`;
  }
}

export class ScmProcessStdinWriteError extends Schema.TaggedError<ScmProcessStdinWriteError>()(
  "ScmProcessStdinWriteError",
  { ...processFields, stdinBytes: WholeNumber, cause: Schema.Defect() },
) {
  override get message() {
    return `VCS process failed to write ${this.stdinBytes} bytes to stdin in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export class ScmProcessOutputReadError extends Schema.TaggedError<ScmProcessOutputReadError>()(
  "ScmProcessOutputReadError",
  {
    ...processFields,
    stream: Schema.Literals(["stdout", "stderr", "exitCode"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `VCS process failed to read ${this.stream} in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export class ScmProcessOutputLimitError extends Schema.TaggedError<ScmProcessOutputLimitError>()(
  "ScmProcessOutputLimitError",
  {
    ...processFields,
    stream: Schema.Literals(["stdout", "stderr"]),
    maxBytes: WholeNumber,
    observedBytes: WholeNumber,
  },
) {
  override get message() {
    return `VCS process ${this.stream} produced ${this.observedBytes} bytes in ${this.operation}: ${this.command} (${this.cwd}), exceeding the ${this.maxBytes} byte limit`;
  }
}

export class ScmProcessMissingExitCodeError extends Schema.TaggedError<ScmProcessMissingExitCodeError>()(
  "ScmProcessMissingExitCodeError",
  processFields,
) {
  override get message() {
    return `VCS process completed without an exit code in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export class ScmRepositoryDetectionError extends Schema.TaggedError<ScmRepositoryDetectionError>()(
  "ScmRepositoryDetectionError",
  {
    cause: Schema.optional(Schema.Defect()),
    detail: Schema.String,
    cwd: Schema.String,
    operation: Schema.String,
  },
) {
  override get message() {
    return (
      "VCS repository detection failed in " + this.operation + ": " + this.cwd + " - " + this.detail
    );
  }
}

export class ScmUnsupportedOperationError extends Schema.TaggedError<ScmUnsupportedOperationError>()(
  "ScmUnsupportedOperationError",
  { operation: Schema.String, kind: ScmDriverKind, detail: Schema.String },
) {
  override get message() {
    return `VCS operation is unsupported for ${this.kind} in ${this.operation}: ${this.detail}`;
  }
}

export const ScmError = Schema.Union([
  ScmProcessSpawnError,
  ScmProcessExitError,
  ScmProcessTimeoutError,
  ScmProcessStdinWriteError,
  ScmProcessOutputReadError,
  ScmProcessOutputLimitError,
  ScmProcessMissingExitCodeError,
  ScmRepositoryDetectionError,
  ScmUnsupportedOperationError,
]);
export type ScmError = Schema.Schema.Type<typeof ScmError>;
