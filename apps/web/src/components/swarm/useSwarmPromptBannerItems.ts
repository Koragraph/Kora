import type { HostId, HostThreadRef, ThreadAgentMode } from "@kora/contracts";
import {
  CircleAlertIcon,
  ClockIcon,
  CrownIcon,
  KeyRoundIcon,
  PackageXIcon,
  SparklesIcon,
} from "lucide-react";
import { createElement, Fragment, type ReactNode } from "react";

import { useSwarmStatus } from "../../hooks/useSwarmStatus";
import { SWARM_LEADER_PROVIDERS, SWARM_PROVIDER_META } from "../../util/swarm";
import { fleetHost } from "../../atoms/fleet";
import { useHostQuery } from "../../atoms/query";
import { swarmHost } from "../../atoms/swarm";
import { useAtomAction } from "../../atoms/use-atom-command";
import { openSwarmQuickSetup, openSwarmSetup } from "../../stores/swarmSetupStore";
import type { PromptBannerStackItem } from "../thread/PromptBannerStack";
import { Button } from "../ui/button";

/** Every Swarm composer banner id (frozen spellings). */
export const SWARM_BANNER_IDS = {
  exhausted: "swarm-exhausted",
  opencodeMissing: "swarm-opencode-missing",
  keyInvalid: "swarm-key-invalid",
  leaderUnsupported: "swarm-leader-unsupported",
  /** assistant lane: free workers are off until the privacy notice is accepted (there is no mode toggle to ask). */
  consentMissing: "swarm-consent-missing",
  /** X4 copy: "Your lead agent is rate-limited until {time}. Your swarm keeps working; your lead agent gets a digest when it's back." */
  leaderLimited: "swarm-leader-limited",
} as const;

export interface SwarmPromptBannerInput {
  readonly hostId: HostId | null;
  /** null for a draft. */
  readonly threadRef: HostThreadRef | null;
  readonly agentMode: ThreadAgentMode;
  /** The selected leader's driver (`claude`, `codex`, …). */
  readonly selectedProvider: string | null;
  /** Epoch ms the leader's rate limit resets (from S1's `leader.rate-limited` activity), else null. */
  readonly leaderRateLimitedUntil: number | null;
  /** The assistant lane: any leader (Claude, Codex, …) may lead the swarm there, and there is no Orchestrator. */
  readonly isAssistantLane?: boolean;
  /** "Switch to Orchestrator" (exhausted banner). */
  readonly onSwitchAgentMode: (mode: ThreadAgentMode) => void;
  /** Claude still needs signing in: its card shows first, so the (optional) free-workers ask waits. */
  readonly claudeSignedOut?: boolean;
}

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;

function action(label: string, onClick: () => void): ReactNode {
  return createElement(Button, { key: label, size: "xs", variant: "ghost", onClick }, label);
}

function actions(...nodes: ReactNode[]): ReactNode {
  return createElement(Fragment, null, ...nodes);
}

function formatResetTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Banner items for PromptBannerStack in Swarm mode. Nothing renders outside Swarm mode or on
 * hosts without the `swarm` capability.
 */
export function useSwarmPromptBannerItems(
  input: SwarmPromptBannerInput,
): ReadonlyArray<PromptBannerStackItem> {
  const { supported, status } = useSwarmStatus(input.hostId);
  const active = supported && input.agentMode === "swarm";
  const snapshot = useHostQuery(
    active && input.threadRef !== null
      ? fleetHost.snapshot({
          hostId: input.threadRef.hostId,
          input: { threadId: input.threadRef.threadId },
        })
      : null,
  ).data?.snapshot;
  const setPreferences = useAtomAction(swarmHost.setPreferences, COMMAND_OPTIONS);

  if (!active) return [];
  const items: PromptBannerStackItem[] = [];

  if (input.leaderRateLimitedUntil !== null) {
    items.push({
      id: SWARM_BANNER_IDS.leaderLimited,
      variant: "info",
      priority: "activity",
      icon: createElement(ClockIcon),
      title: `Your lead agent is rate-limited until ${formatResetTime(input.leaderRateLimitedUntil)}.`,
      description: "Your swarm keeps working; your lead agent gets a digest when it's back.",
    });
  }

  if (
    !input.isAssistantLane &&
    input.selectedProvider !== null &&
    !SWARM_LEADER_PROVIDERS.has(input.selectedProvider)
  ) {
    items.push({
      id: SWARM_BANNER_IDS.leaderUnsupported,
      variant: "info",
      icon: createElement(CrownIcon),
      title: "Stretch can't be led by this model yet.",
      description:
        "Pick a Claude, Codex or OpenCode model in the model picker, or switch back to Chat.",
      actions: action("Switch to Chat", () => input.onSwitchAgentMode("chat")),
    });
  }

  // On Code the Swarm toggle opens setup (and its privacy notice) before a thread can be swarm; the assistant lane
  // is always swarm, so without this nothing ever asks and every worker spawn is refused.
  const consentMissing =
    input.isAssistantLane === true && status?.blockers.some((b) => b.code === "consent-missing");
  // One ask at a time: signing in to Claude comes first; the free-workers offer follows once that is done.
  if (consentMissing && input.claudeSignedOut !== true) {
    items.push({
      id: SWARM_BANNER_IDS.consentMissing,
      variant: "info",
      icon: createElement(SparklesIcon),
      title: "Turn on free workers to save your plan.",
      description:
        "Kora hands reading and research to free models. Review the privacy notice once to enable them.",
      actions: action("Review & enable", () => openSwarmQuickSetup()),
    });
  }

  const opencodeBlocker = status?.blockers.find(
    (blocker) =>
      blocker.code === "opencode-missing" ||
      blocker.code === "opencode-too-old" ||
      blocker.code === "koragent-missing" ||
      blocker.code === "koragent-too-old",
  );
  // Before the user has opted in, "Review & enable" walks through setup (OpenCode included): a red
  // "not installed" error on a fresh install's first screen is noise about a step they never chose.
  if (opencodeBlocker && !consentMissing) {
    const koragent = opencodeBlocker.code.startsWith("koragent");
    const name = koragent ? "Koragent" : "OpenCode";
    items.push({
      id: SWARM_BANNER_IDS.opencodeMissing,
      variant: "error",
      icon: createElement(PackageXIcon),
      title: opencodeBlocker.code.endsWith("too-old")
        ? `${name} is too old for Stretch.`
        : koragent
          ? "Koragent isn't installed or can't be found."
          : "OpenCode isn't installed or can't be found.",
      description: `Stretch runs its free workers in ${name}. Finish setup to start them.`,
      actions: action("Fix setup", () => openSwarmQuickSetup()),
    });
  }

  const rejected = status?.providers.find(
    (provider) => provider.enabled && provider.lastTest?.outcome === "invalid-key",
  );
  if (rejected && input.hostId !== null) {
    const hostId = input.hostId;
    const label = SWARM_PROVIDER_META[rejected.provider].label;
    items.push({
      id: SWARM_BANNER_IDS.keyInvalid,
      variant: "warning",
      icon: createElement(KeyRoundIcon),
      title: `Your ${label} key was rejected.`,
      description: "Workers skip this provider until the key works.",
      actions: actions(
        action("Update key", () => openSwarmSetup({ step: "providers" })),
        action("Disable provider", () => {
          void setPreferences({
            hostId,
            input: { enabled: [{ provider: rejected.provider, enabled: false }] },
          });
        }),
      ),
    });
  }

  if (snapshot?.swarm?.exhausted === true) {
    items.push({
      id: SWARM_BANNER_IDS.exhausted,
      variant: "warning",
      icon: createElement(CircleAlertIcon),
      title: "All free providers are rate-limited or out of quota.",
      description: "Workers are paused; your lead agent has been told.",
      actions: actions(
        action("Add a provider key", () => openSwarmSetup({ step: "providers" })),
        action("Switch to Orchestrator", () => input.onSwitchAgentMode("orchestrator")),
      ),
    });
  }

  return items;
}
