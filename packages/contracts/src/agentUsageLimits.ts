import * as Schema from "effect/Schema";

import { AgentId, AgentProfileId } from "./agentProfile.ts";
import { IsoInstant, LenientArray, NonblankString, WholeNumber } from "./primitives.ts";
import { QuotaSourceId } from "./quotaSource.ts";

/**
 * One rolling quota window. `id` is stable per provider (five_hour, seven_day_opus,
 * primary, ...) so sparse updates land on the same row; `kind` only orders and labels the bar.
 */
export const AgentUsageWindow = Schema.Struct({
  id: NonblankString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: NonblankString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optionalKey(IsoInstant),
  windowDurationMins: Schema.optionalKey(WholeNumber),
});
export type AgentUsageWindow = typeof AgentUsageWindow.Type;

export const AgentResetCredits = Schema.Struct({
  availableCount: WholeNumber,
  nextExpiresAt: Schema.optionalKey(IsoInstant),
  // Pins a redemption to the credit that was on screen, retries from another client included.
  nextCreditId: Schema.optionalKey(NonblankString),
});
export type AgentResetCredits = typeof AgentResetCredits.Type;

export const AgentUsageLimits = Schema.Struct({
  checkedAt: IsoInstant,
  windows: LenientArray(AgentUsageWindow),
  resetCredits: Schema.optionalKey(AgentResetCredits),
  plan: Schema.optionalKey(NonblankString),
  // The provider is refusing turns now. A past `resetsAt` reads as lifted without a new probe.
  limited: Schema.optionalKey(
    Schema.Struct({
      resetsAt: Schema.optionalKey(IsoInstant),
      message: Schema.optionalKey(NonblankString),
    }),
  ),
  // "unsupported" accounts can never report windows (API key, Bedrock); "probeFailed" keeps the last good bars.
  unavailable: Schema.optionalKey(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "probeFailed"]),
      message: Schema.optionalKey(NonblankString),
    }),
  ),
});
export type AgentUsageLimits = typeof AgentUsageLimits.Type;

/** Sparse by contract: windows merge by `id` onto the published snapshot; omitted ones are unchanged. */
export const AgentUsageLimitsUpdate = Schema.Struct({ windows: Schema.Array(AgentUsageWindow) });
export type AgentUsageLimitsUpdate = typeof AgentUsageLimitsUpdate.Type;

/** An account the environment cannot run turns on; clients blur its email like provider auth. */
export const UsageLimitSourceAccount = Schema.Struct({
  id: NonblankString,
  driver: AgentId,
  email: Schema.optionalKey(NonblankString),
  plan: Schema.optionalKey(NonblankString),
  usageLimits: AgentUsageLimits,
});
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

export const UsageLimitSourceSnapshot = Schema.Struct({
  id: QuotaSourceId,
  kind: Schema.Literal("cliproxy"),
  label: NonblankString,
  checkedAt: IsoInstant,
  accounts: LenientArray(UsageLimitSourceAccount),
  // An unreadable source keeps its `error` and an empty account list rather than vanishing.
  error: Schema.optionalKey(NonblankString),
});
export type UsageLimitSourceSnapshot = typeof UsageLimitSourceSnapshot.Type;

export const QuotaSourceSnapshots = LenientArray(UsageLimitSourceSnapshot);
export type QuotaSourceSnapshots = typeof QuotaSourceSnapshots.Type;

export const UsageLimitSourceConsumeResetCreditInput = Schema.Struct({
  sourceId: QuotaSourceId,
  accountId: NonblankString,
  creditId: NonblankString,
});
export type UsageLimitSourceConsumeResetCreditInput =
  typeof UsageLimitSourceConsumeResetCreditInput.Type;

export const AgentConsumeResetCreditInput = Schema.Union([
  Schema.Struct({ instanceId: AgentProfileId }),
  UsageLimitSourceConsumeResetCreditInput,
]);
export type AgentConsumeResetCreditInput = typeof AgentConsumeResetCreditInput.Type;

export const UsageLimitsReport = Schema.Struct({
  createdAt: IsoInstant,
  accounts: Schema.Array(
    Schema.Struct({
      id: NonblankString,
      driver: AgentId,
      label: NonblankString,
      plan: Schema.optionalKey(NonblankString),
      email: Schema.optionalKey(NonblankString),
      sourceLabel: Schema.optionalKey(NonblankString),
      instanceId: Schema.optionalKey(AgentProfileId),
      resetCreditInput: Schema.optionalKey(AgentConsumeResetCreditInput),
      displayName: Schema.optionalKey(Schema.String),
      accentColor: Schema.optionalKey(Schema.String),
      limits: AgentUsageLimits,
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsReport = typeof UsageLimitsReport.Type;
