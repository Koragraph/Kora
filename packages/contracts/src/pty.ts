import * as Schema from "effect/Schema";

import { AgentProfileId } from "./agentProfile.ts";
import { NonblankString } from "./primitives.ts";

const COLS = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }));
const ROWS = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }));
const TERMINAL_ID = NonblankString.check(Schema.isMaxLength(128));
const LABEL = Schema.String.check(Schema.isMaxLength(128));
const SEQUENCE = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const EnvironmentMap = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/), Schema.isMaxLength(128)),
  Schema.String.check(Schema.isMaxLength(8192)),
).check(Schema.makeFilter((env) => Object.keys(env).length <= 128));

// The client always picks the terminal id and sends it; the server never allocates one.
const sessionFields = {
  threadId: NonblankString,
  terminalId: TERMINAL_ID,
};

export const PtyThreadInput = Schema.Struct({ threadId: NonblankString });
export type PtyThreadInput = typeof PtyThreadInput.Type;

export const PtyOpenInput = Schema.Struct({
  ...sessionFields,
  cwd: NonblankString,
  worktreePath: Schema.optionalKey(Schema.NullOr(NonblankString)),
  cols: Schema.optionalKey(COLS),
  rows: Schema.optionalKey(ROWS),
  env: Schema.optionalKey(EnvironmentMap),
  providerInstanceId: Schema.optionalKey(AgentProfileId),
});
export type PtyOpenInput = typeof PtyOpenInput.Type;

export const PtyAttachInput = Schema.Struct({
  ...sessionFields,
  cwd: Schema.optionalKey(NonblankString),
  worktreePath: Schema.optionalKey(Schema.NullOr(NonblankString)),
  cols: Schema.optionalKey(COLS),
  rows: Schema.optionalKey(ROWS),
  env: Schema.optionalKey(EnvironmentMap),
  providerInstanceId: Schema.optionalKey(AgentProfileId),
  restartIfNotRunning: Schema.optionalKey(Schema.Boolean),
});
export type PtyAttachInput = typeof PtyAttachInput.Type;

export const PtyWriteInput = Schema.Struct({
  ...sessionFields,
  data: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(65536)),
});
export type PtyWriteInput = typeof PtyWriteInput.Type;

export const PtyResizeInput = Schema.Struct({ ...sessionFields, cols: COLS, rows: ROWS });
export type PtyResizeInput = typeof PtyResizeInput.Type;

export const PtyCloseInput = Schema.Struct({
  threadId: NonblankString,
  terminalId: Schema.optionalKey(TERMINAL_ID),
  deleteHistory: Schema.optionalKey(Schema.Boolean),
});
export type PtyCloseInput = typeof PtyCloseInput.Type;

export const TerminalSessionStatus = Schema.Literals(["starting", "running", "exited", "error"]);
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type;

const positivePid = Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)));
const exitFields = {
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
};

export const PtySessionSnapshot = Schema.Struct({
  threadId: NonblankString,
  terminalId: TERMINAL_ID,
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(NonblankString),
  status: TerminalSessionStatus,
  pid: positivePid,
  ...exitFields,
  history: Schema.String,
  // Display title computed by the server: the idle shell, or the running subprocess's command.
  label: LABEL,
  updatedAt: Schema.String,
  sequence: Schema.optionalKey(SEQUENCE),
});
export type PtySessionSnapshot = typeof PtySessionSnapshot.Type;

export const PtySummary = Schema.Struct({
  threadId: NonblankString,
  terminalId: TERMINAL_ID,
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(NonblankString),
  status: TerminalSessionStatus,
  pid: positivePid,
  ...exitFields,
  hasRunningSubprocess: Schema.Boolean,
  label: LABEL,
  updatedAt: Schema.String,
});
export type PtySummary = typeof PtySummary.Type;

export const PtyMetaStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), terminals: Schema.Array(PtySummary) }),
  Schema.Struct({ type: Schema.Literal("upsert"), terminal: PtySummary }),
  Schema.Struct({
    type: Schema.Literal("remove"),
    threadId: NonblankString,
    terminalId: TERMINAL_ID,
  }),
]);
export type PtyMetaStreamEvent = typeof PtyMetaStreamEvent.Type;

const attachEventBase = {
  threadId: NonblankString,
  terminalId: NonblankString,
  sequence: Schema.optionalKey(SEQUENCE),
};

export const PtyAttachStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: PtySessionSnapshot }),
  Schema.Struct({ ...attachEventBase, type: Schema.Literal("output"), data: Schema.String }),
  Schema.Struct({
    ...attachEventBase,
    ...exitFields,
    type: Schema.Literal("exited"),
  }),
  Schema.Struct({ ...attachEventBase, type: Schema.Literal("closed") }),
  Schema.Struct({
    ...attachEventBase,
    type: Schema.Literal("error"),
    message: Schema.String.check(Schema.isNonEmpty()),
  }),
  Schema.Struct({ ...attachEventBase, type: Schema.Literal("cleared") }),
  Schema.Struct({
    ...attachEventBase,
    type: Schema.Literal("restarted"),
    snapshot: PtySessionSnapshot,
  }),
  Schema.Struct({
    ...attachEventBase,
    type: Schema.Literal("activity"),
    hasRunningSubprocess: Schema.Boolean,
    label: LABEL,
  }),
]);
export type PtyAttachStreamEvent = typeof PtyAttachStreamEvent.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TerminalCwdNotFoundError extends Schema.TaggedError<TerminalCwdNotFoundError>()(
  "TerminalCwdNotFoundError",
  { cwd: Schema.String },
) {
  override get message() {
    return "Terminal cwd does not exist: " + this.cwd;
  }
}

export class TerminalCwdNotDirectoryError extends Schema.TaggedError<TerminalCwdNotDirectoryError>()(
  "TerminalCwdNotDirectoryError",
  { cwd: Schema.String },
) {
  override get message() {
    return "Terminal cwd is not a directory: " + this.cwd;
  }
}

export class TerminalCwdStatError extends Schema.TaggedError<TerminalCwdStatError>()(
  "TerminalCwdStatError",
  { cause: Schema.Defect(), cwd: Schema.String },
) {
  override get message() {
    return "Failed to access terminal cwd: " + this.cwd;
  }
}

const TERMINAL_CWD_ERRORS = [
  TerminalCwdStatError,
  TerminalCwdNotFoundError,
  TerminalCwdNotDirectoryError,
] as const;
export const TerminalCwdError = Schema.Union(TERMINAL_CWD_ERRORS);
export type TerminalCwdError = (typeof TerminalCwdError)["Type"];

export class TerminalHistoryError extends Schema.TaggedError<TerminalHistoryError>()(
  "TerminalHistoryError",
  {
    cause: Schema.optional(Schema.Defect()),
    terminalId: Schema.String,
    threadId: Schema.String,
    operation: Schema.Literals(["read", "truncate", "migrate"]),
  },
) {
  override get message() {
    const where = "thread: " + this.threadId + ", terminal: " + this.terminalId;
    return "Failed to " + this.operation + " terminal history for " + where;
  }
}

export class TerminalSessionLookupError extends Schema.TaggedError<TerminalSessionLookupError>()(
  "TerminalSessionLookupError",
  { threadId: Schema.String, terminalId: Schema.String },
) {
  override get message() {
    return "Unknown terminal thread: " + this.threadId + ", terminal: " + this.terminalId;
  }
}

export class TerminalAgentProfileNotFoundError extends Schema.TaggedError<TerminalAgentProfileNotFoundError>()(
  "TerminalAgentProfileNotFoundError",
  { providerInstanceId: AgentProfileId },
) {
  override get message() {
    return `Provider instance is not available: ${this.providerInstanceId}`;
  }
}

export class TerminalAgentEnvError extends Schema.TaggedError<TerminalAgentEnvError>()(
  "TerminalAgentEnvError",
  { providerInstanceId: AgentProfileId, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not prepare the terminal environment for provider instance: ${this.providerInstanceId}`;
  }
}

export class PtyNotRunningError extends Schema.TaggedError<PtyNotRunningError>()(
  "PtyNotRunningError",
  { threadId: Schema.String, terminalId: Schema.String },
) {
  override get message() {
    return (
      "Terminal is not running for thread: " + this.threadId + ", terminal: " + this.terminalId
    );
  }
}

export class TerminalWriteError extends Schema.TaggedError<TerminalWriteError>()(
  "TerminalWriteError",
  {
    cause: Schema.Defect(),
    terminalPid: Schema.Number,
    terminalId: Schema.String,
    threadId: Schema.String,
  },
) {
  override get message() {
    const target = `thread: ${this.threadId}, terminal: ${this.terminalId}, PID: ${this.terminalPid}`;
    return "Failed to write to terminal for " + target;
  }
}

export class TerminalResizeError extends Schema.TaggedError<TerminalResizeError>()(
  "TerminalResizeError",
  {
    cause: Schema.Defect(),
    rows: Schema.Number,
    cols: Schema.Number,
    terminalPid: Schema.Number,
    terminalId: Schema.String,
    threadId: Schema.String,
  },
) {
  override get message() {
    const target = `thread: ${this.threadId}, terminal: ${this.terminalId}, PID: ${this.terminalPid}`;
    return "Failed to resize terminal for " + target + " to " + this.cols + "x" + this.rows;
  }
}

export const PtyError = Schema.Union([
  TerminalSessionLookupError,
  TerminalHistoryError,
  TerminalCwdError,
  TerminalAgentProfileNotFoundError,
  TerminalAgentEnvError,
  PtyNotRunningError,
  TerminalWriteError,
  TerminalResizeError,
]);
export type PtyError = typeof PtyError.Type;
