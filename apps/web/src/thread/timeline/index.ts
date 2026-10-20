/** Everything the thread view derives from a thread's activity stream: work rows, plans, transcript, turn state. */
export type { PendingApproval, PendingQuestion } from "@kora/client-runtime/approvals";
export { formatDuration } from "@kora/shared/turnTiming";
export {
  activityRowShowsFailure,
  activityRowSucceeded,
  activityRowIsToolLike,
  type ActivityLogToolLifecycleStatus,
} from "@kora/client-runtime/worklog/presentation";

export {
  activityRowIndicatesToolNeutralStatus,
  activityRowSignalsSevereFailure,
  type BlobCardRef,
  type WorkLogEntry,
} from "./entries";
export {
  deriveActivePlanState,
  findLatestPlanProposal,
  hasActionableProposedPlan,
  type ActivePlanState,
  type LatestPlanProposalState,
} from "./plans";
export {
  deriveTranscriptEntries,
  deriveTranscriptEntriesWithState,
  isStreamingMessageTextUpdate,
  type TranscriptEntriesProjection,
  type TranscriptItem,
} from "./transcript";
export { derivePhase, deriveActiveWorkStartedAt, isLatestTurnSettled } from "./turns";
export { deriveActivityRows } from "./workLog";
