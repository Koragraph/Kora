import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, NonblankString } from "./primitives.ts";

export const SHELL_LAUNCH_PROTOCOL_VERSION = 1 as const;

export const ShellLaunchPlatform = Schema.Literals(["darwin", "linux", "win32"]);
export type ShellLaunchPlatform = typeof ShellLaunchPlatform.Type;

export const ShellLaunchRequest = Schema.Struct({
  version: Schema.Literal(SHELL_LAUNCH_PROTOCOL_VERSION),
  requestId: NonblankString,
  type: Schema.Literal("open-workspace"),
  workspaceRoot: NonblankString,
  platform: ShellLaunchPlatform,
});
export type ShellLaunchRequest = typeof ShellLaunchRequest.Type;

export const ShellLaunchErrorCode = Schema.Literals([
  ...(["invalid-request", "renderer-unavailable"] as const),
  ...(["environment-unavailable", "platform-mismatch"] as const),
  ...(["project-create-failed", "thread-open-failed"] as const),
  ...(["request-timeout", "internal-error"] as const),
]);
export type ShellLaunchErrorCode = typeof ShellLaunchErrorCode.Type;

export const ShellLaunchSuccess = Schema.Struct({
  version: Schema.Literal(SHELL_LAUNCH_PROTOCOL_VERSION),
  requestId: NonblankString,
  threadId: ThreadId,
  projectId: ProjectId,
  ok: Schema.Literal(true),
});
export type ShellLaunchSuccess = typeof ShellLaunchSuccess.Type;

export const ShellLaunchFailure = Schema.Struct({
  version: Schema.Literal(SHELL_LAUNCH_PROTOCOL_VERSION),
  requestId: NonblankString,
  ok: Schema.Literal(false),
  code: ShellLaunchErrorCode,
  message: NonblankString,
});
export type ShellLaunchFailure = typeof ShellLaunchFailure.Type;

export const ShellLaunchResponse = Schema.Union([ShellLaunchSuccess, ShellLaunchFailure]);
export type ShellLaunchResponse = typeof ShellLaunchResponse.Type;
