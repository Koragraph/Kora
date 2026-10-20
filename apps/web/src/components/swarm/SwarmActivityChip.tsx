import { cn } from "~/util/utils";
import { formatSwarmActivity } from "~/util/swarm";
import { latestContextWindowSnapshot, formatContextWindowTokens } from "~/util/contextWindow";
import { openSwarmSetup } from "~/stores/swarmSetupStore";
import { useHostQuery } from "~/atoms/query";
import { fleetHost } from "~/atoms/fleet";
import { useThread, useThreadSummary } from "~/atoms/entities";
import { formatSwarmValueMeter, leadName } from "./swarmTasks";
import {
  MenuItem,
  MenuGroup,
  MenuPopup,
  Menu,
  MenuTrigger,
  MenuSeparator,
  MenuGroupLabel,
} from "../ui/menu";
import type { FleetSwarmActivity, HostThreadRef } from "@kora/contracts";
import { useMemo } from "react";
import { HexagonIcon } from "lucide-react";

export interface SwarmActivityChipProps {
  /** The swarm thread; null (a draft) renders nothing. The chip reads its fleet snapshot and usage itself. */
  readonly threadRef: HostThreadRef | null;
  readonly compact?: boolean;
}

const EMPTY_ACTIVITY: FleetSwarmActivity = {
  delegated: 0,
  reportsReturned: 0,
  respawns: 0,
  passedFirstTry: 0,
  bounced: 0,
  byModel: [],
  exhausted: false,
};

/**
 * Presentational half (tested on its own). Measured values only: counts from the fleet snapshot and the Claude
 * context size the thread's own usage activity reports. No dollars, no "saved" — enforced by a test.
 * `claudeTokens` is null when this thread has no usage activity (the Claude chat lane does not emit one today),
 * and then the line is simply absent rather than estimated.
 */
export function SwarmActivityChipView(props: {
  readonly activity: FleetSwarmActivity | null;
  readonly claudeTokens: number | null;
  /** The lead's name for the copy; Claude when absent. */
  readonly lead?: string;
  readonly onOpenSettings?: (() => void) | undefined;
  /** Narrow composer: the delegated count only (the full line stays the accessible name). */
  readonly compact?: boolean;
}) {
  const activity = props.activity ?? EMPTY_ACTIVITY;
  // Nothing to report until the leader delegates (the Team toggle already says the thread is a swarm).
  if (activity.delegated === 0 && !activity.exhausted) return null;
  const lines = formatSwarmActivity(activity);
  // The measured value meter (leader + worker tokens) when the daemon reports them; else the context size.
  const meter = formatSwarmValueMeter(props.activity, props.lead);
  const measured = props.activity?.leaderTokens !== undefined;
  const summary = [`Stretch · ${activity.delegated} delegated`];
  if (activity.reportsReturned > 0)
    summary.push(`${activity.reportsReturned} report${activity.reportsReturned === 1 ? "" : "s"}`);
  if (activity.exhausted) summary.push("no free models");
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            data-testid="swarm-activity-chip"
            aria-label={summary.join(" · ")}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border/60 bg-background/60 px-2.5",
              "text-xs font-medium text-foreground/80 transition-colors",
              "hover:border-border hover:bg-accent hover:text-accent-foreground",
              activity.exhausted && "text-warning",
            )}
          />
        }
      >
        <HexagonIcon className="size-3.5 shrink-0" aria-hidden />
        <span>{props.compact ? String(activity.delegated) : summary.join(" · ")}</span>
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="w-72">
        <MenuGroup>
          <MenuGroupLabel className="whitespace-normal text-xs font-normal text-muted-foreground">
            This thread
          </MenuGroupLabel>
          <ul className="px-2 pb-1 text-xs leading-relaxed" data-testid="swarm-activity-lines">
            {measured ? (
              <>
                <li className="font-medium">{meter.summary}</li>
                {meter.detail.map((line) => (
                  <li key={line} className="text-muted-foreground">
                    {line}
                  </li>
                ))}
              </>
            ) : props.claudeTokens !== null ? (
              <li>
                {props.lead ?? "Claude"} context: {formatContextWindowTokens(props.claudeTokens)}{" "}
                tokens
              </li>
            ) : null}
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </MenuGroup>
        {props.onOpenSettings ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={props.onOpenSettings}>
              <HexagonIcon className="size-3.5" />
              Swarm setup…
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/**
 * Composer-footer chip (after GraphStatusChip, Swarm mode only): measured counts only — Claude
 * tokens this thread, delegated, passed first try, bounced, failed over. No dollars, no "saved".
 */
export function SwarmActivityChip({ threadRef, compact }: SwarmActivityChipProps) {
  const snapshot = useHostQuery(
    threadRef === null
      ? null
      : fleetHost.snapshot({ hostId: threadRef.hostId, input: { threadId: threadRef.threadId } }),
  ).data?.snapshot;
  const thread = useThread(threadRef);
  const shell = useThreadSummary(threadRef);
  const activities = thread?.activities;
  const claudeTokens = useMemo(
    () => (activities ? (latestContextWindowSnapshot(activities)?.usedTokens ?? null) : null),
    [activities],
  );
  if (threadRef === null) return null;
  return (
    <SwarmActivityChipView
      activity={snapshot?.swarm ?? null}
      claudeTokens={claudeTokens}
      lead={leadName(shell)}
      onOpenSettings={() => openSwarmSetup()}
      compact={compact ?? false}
    />
  );
}
