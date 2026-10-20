import * as Schema from "effect/Schema";

import { AgentId, AgentProfileId } from "./agentProfile.ts";
import {
  AgentItemId,
  EventId,
  IsoInstant,
  NonblankString,
  RequestId,
  ThreadId,
  TurnId,
} from "./primitives.ts";
import {
  AGENT_SEND_TURN_MAX_ATTACHMENTS,
  AGENT_SEND_TURN_MAX_INPUT_CHARS,
  AccessMode,
  AgentApprovalPolicy,
  AgentRequestKind,
  AgentSandboxMode,
  AgentTurnMode,
  MessageAttachment,
  ModelPick,
} from "./chat.ts";

// The wire records of an agent session. Turn control and request responses travel
// through the chat dispatch commands now, so only these shapes remain.

export const AgentSession = Schema.Struct({
  provider: AgentId,
  // Optional while routing moves from driver to instance; `provider` then goes away.
  providerInstanceId: Schema.optionalKey(AgentProfileId),
  status: Schema.Literals(["connecting", "ready", "running", "error", "closed"]),
  runtimeMode: AccessMode,
  cwd: Schema.optionalKey(NonblankString),
  model: Schema.optionalKey(NonblankString),
  threadId: ThreadId,
  resumeCursor: Schema.optionalKey(Schema.Unknown),
  activeTurnId: Schema.optionalKey(TurnId),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
  lastError: Schema.optionalKey(NonblankString),
});
export type AgentSession = typeof AgentSession.Type;

export const AgentSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optionalKey(AgentId),
  providerInstanceId: Schema.optionalKey(AgentProfileId),
  cwd: Schema.optionalKey(NonblankString),
  title: Schema.optionalKey(NonblankString),
  modelSelection: Schema.optionalKey(ModelPick),
  resumeCursor: Schema.optionalKey(Schema.Unknown),
  approvalPolicy: Schema.optionalKey(AgentApprovalPolicy),
  sandboxMode: Schema.optionalKey(AgentSandboxMode),
  runtimeMode: AccessMode,
});
export type AgentSessionStartInput = typeof AgentSessionStartInput.Type;

export const AgentSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  // Internal recovery signal: an empty turn is allowed only for adapters that support
  // promptless continuation.
  continuation: Schema.optionalKey(Schema.Boolean),
  input: Schema.optionalKey(
    NonblankString.check(Schema.isMaxLength(AGENT_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optionalKey(
    Schema.Array(MessageAttachment).check(Schema.isMaxLength(AGENT_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  modelSelection: Schema.optionalKey(ModelPick),
  interactionMode: Schema.optionalKey(AgentTurnMode),
});
export type AgentSendTurnInput = typeof AgentSendTurnInput.Type;

export const AgentUploadFeedbackInput = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optionalKey(NonblankString),
});
export type AgentUploadFeedbackInput = typeof AgentUploadFeedbackInput.Type;

export const AgentUploadFeedbackResult = Schema.Struct({ feedbackId: NonblankString });
export type AgentUploadFeedbackResult = typeof AgentUploadFeedbackResult.Type;

export class AgentUploadFeedbackError extends Schema.TaggedError<AgentUploadFeedbackError>()(
  "AgentUploadFeedbackError",
  { threadId: ThreadId, cause: Schema.optionalKey(Schema.Defect()) },
) {
  override get message() {
    return `Failed to upload feedback for thread ${this.threadId}.`;
  }
}

export const AgentEvent = Schema.Struct({
  id: EventId,
  kind: Schema.Literals(["session", "notification", "request", "error"]),
  provider: AgentId,
  providerInstanceId: Schema.optionalKey(AgentProfileId),
  threadId: ThreadId,
  createdAt: IsoInstant,
  method: NonblankString,
  message: Schema.optionalKey(NonblankString),
  turnId: Schema.optionalKey(TurnId),
  itemId: Schema.optionalKey(AgentItemId),
  requestId: Schema.optionalKey(RequestId),
  requestKind: Schema.optionalKey(AgentRequestKind),
  textDelta: Schema.optionalKey(Schema.String),
  payload: Schema.optionalKey(Schema.Unknown),
});
export type AgentEvent = typeof AgentEvent.Type;
