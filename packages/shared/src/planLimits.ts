import type {
  AgentConsumeResetCreditInput,
  AgentSlashCommand,
  AgentStatus,
  AgentUsageLimits,
  AgentUsageWindow,
  HostId,
  QuotaSourceSnapshots,
} from "@kora/contracts";

// The shapes the usage view pools quota windows into. Pooling itself lives with the callers.

export type LimitPresentations = ReadonlyMap<
  HostId,
  {
    readonly entry: { readonly target: { readonly label: string } };
    readonly daemonConfig: {
      readonly providers?: readonly AgentStatus[];
      readonly usageLimitSources?: QuotaSourceSnapshots;
    } | null;
  }
>;

/**
 * One subscription account. The same email signed in natively on two environments, or reported
 * by a hub as well as natively, is one account (one quota bucket) and must not be counted twice.
 */
export interface LimitAccount {
  readonly key: string;
  readonly driver: AgentStatus["driver"];
  /** The instance's configured name; null for hub accounts. */
  readonly accentColor: string | undefined;
  readonly plan: string | undefined;
  readonly email: string | undefined;
  readonly displayName: string | null;
  /** Empty when only a hub reports the account. */
  readonly environments: ReadonlyArray<{ hostId: HostId; label: string }>;
  /** The hub that reported it, when no environment has it natively. */
  readonly sourceLabel: string | null;
  readonly redeem: { hostId: HostId; input: AgentConsumeResetCreditInput } | null;
  readonly limits: AgentUsageLimits;
}

export interface LimitPoolMember {
  readonly account: LimitAccount;
  readonly window: AgentUsageWindow;
}

export type LimitPace = "ahead" | "on" | "under";

export interface LimitPoolWindow {
  readonly id: string;
  readonly kind: AgentUsageWindow["kind"];
  /** In the order they land; `restoresPercent` is the member's used share divided by the member count. */
  readonly resets: ReadonlyArray<{
    restoresPercent: number;
    at: number;
    member: LimitPoolMember;
  }>;
  readonly pace: LimitPace | null;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  /** One entry per account in a fixed order, so rows line up. */
  readonly columns: ReadonlyArray<{
    window: AgentUsageWindow | null;
    account: LimitAccount;
  }>;
  readonly members: readonly LimitPoolMember[];
  readonly label: string;
}

export interface LimitPool {
  readonly driver: AgentStatus["driver"];
  readonly accounts: readonly LimitAccount[];
  readonly windows: readonly LimitPoolWindow[];
}

/** What is left of a window (as Codex shows it), 0 to 100. */
export function remainingPercent(window: AgentUsageWindow): number {
  return Math.round(100 - Math.min(100, Math.max(0, window.usedPercent)));
}

/** Handled by Kora itself (Settings > Usage); never sent to the agent. */
export const USAGE_LIMITS_COMMAND = {
  name: "usage",
  description: "Context, cost and plan limits",
} as const satisfies AgentSlashCommand;
