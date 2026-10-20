import * as Schema from "effect/Schema";

import { IsoInstant, NonblankString } from "./primitives.ts";
import { AgentId, AgentProfileId } from "./agentProfile.ts";

export const AgentSetupInput = Schema.Struct({
  instanceId: AgentProfileId,
});
export type AgentSetupInput = Schema.Schema.Type<typeof AgentSetupInput>;

const SetupOperationId = NonblankString.check(Schema.isMaxLength(128));

export const AgentAuthState = Schema.Struct({
  instanceId: AgentProfileId,
  message: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(IsoInstant),
  authorizationUrl: Schema.NullOr(Schema.String),
  flowId: Schema.NullOr(SetupOperationId),
  phase: Schema.Literals([
    ...(["idle", "starting", "waiting"] as const),
    ...(["verifying", "succeeded"] as const),
    ...(["failed", "cancelled"] as const),
  ]),
});
export type AgentAuthState = (typeof AgentAuthState)["Type"];

export const AgentAuthCompleteInput = Schema.Struct({
  instanceId: AgentProfileId,
  flowId: SetupOperationId,
  callbackUrl: NonblankString.check(Schema.isMaxLength(16_384)),
});
export type AgentAuthCompleteInput = Schema.Schema.Type<typeof AgentAuthCompleteInput>;

export const AgentAuthCancelInput = Schema.Struct({
  instanceId: AgentProfileId,
  flowId: SetupOperationId,
});
export type AgentAuthCancelInput = Schema.Schema.Type<typeof AgentAuthCancelInput>;

const ByteCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const AgentInstallState = Schema.Struct({
  driver: AgentId,
  totalBytes: Schema.NullOr(ByteCount),
  downloadedBytes: ByteCount,
  phase: Schema.Literals([
    ...(["idle", "downloading", "extracting"] as const),
    ...(["verifying", "succeeded"] as const),
    ...(["failed", "cancelled"] as const),
  ]),
  operationId: Schema.NullOr(SetupOperationId),
  version: Schema.NullOr(NonblankString),
  installedVersion: Schema.NullOr(NonblankString),
  canRemove: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type AgentInstallState = Schema.Schema.Type<typeof AgentInstallState>;

export const AgentInstallCancelInput = Schema.Struct({
  instanceId: AgentProfileId,
  operationId: SetupOperationId,
});
export type AgentInstallCancelInput = Schema.Schema.Type<typeof AgentInstallCancelInput>;

/** Safe setup failure text. Never include OAuth codes, URLs, or native token data. */
export class AgentSetupError extends Schema.TaggedError<AgentSetupError>()("AgentSetupError", {
  instanceId: AgentProfileId,
  cause: Schema.optional(Schema.Defect()),
  detail: Schema.String,
  operation: Schema.String,
}) {
  override get message(): string {
    return `${this.detail}`;
  }
}
