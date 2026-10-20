import type { SwarmProviderStatus, SwarmStatus } from "@kora/contracts";
import { CheckIcon, CircleAlertIcon, CircleDashedIcon, MinusIcon } from "lucide-react";

import { SWARM_PROVIDER_META, koragentReadiness, swarmWorkerBackend } from "../../util/swarm";
import { cn } from "../../util/utils";
import type { SwarmSetupStep } from "../../stores/swarmSetupStore";
import { Button } from "../ui/button";

type RowState = "ok" | "optional" | "problem" | "untested";

interface ChecklistRow {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly state: RowState;
  readonly step: SwarmSetupStep;
  /** The link text; rows without a problem still offer a way to change them. */
  readonly fixLabel: string;
}

const hasConsent = (status: SwarmStatus) =>
  status.consent.acceptedVersion !== null &&
  status.consent.acceptedVersion >= status.consent.requiredVersion;

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** The worker program row: Koragent on the koragent backend (its install, version gate and pin). */
function koragentRow(status: SwarmStatus): ChecklistRow {
  const state = koragentReadiness(status);
  return {
    id: "koragent",
    label: "Koragent",
    detail: state.label,
    state: state.ok ? "ok" : "problem",
    step: "opencode",
    fixLabel: state.ok ? "Change" : "Fix",
  };
}

function opencodeRow(status: SwarmStatus): ChecklistRow {
  if (swarmWorkerBackend(status) === "koragent") return koragentRow(status);
  const { opencode } = status;
  if (!opencode.installed) {
    return {
      id: "opencode",
      label: "OpenCode",
      detail: "Not installed",
      state: "problem",
      step: "opencode",
      fixLabel: "Fix",
    };
  }
  if (!opencode.versionOk) {
    return {
      id: "opencode",
      label: "OpenCode",
      detail: `${opencode.version ?? "Unknown version"} is too old (needs ${opencode.minVersion} or newer)`,
      state: "problem",
      step: "opencode",
      fixLabel: "Fix",
    };
  }
  return {
    id: "opencode",
    label: "OpenCode",
    detail: opencode.version ?? "Installed",
    state: "ok",
    step: "opencode",
    fixLabel: "Change",
  };
}

function testDetail(provider: SwarmProviderStatus): string | null {
  const test = provider.lastTest;
  if (test === null) return null;
  switch (test.outcome) {
    case "ok": {
      const count = test.freeModels.length;
      return `Works · ${count} free ${count === 1 ? "model" : "models"}`;
    }
    case "invalid-key":
      return "Key rejected";
    case "rate-limited":
      return "Out of free requests for now";
    case "unreachable":
      return "Couldn't reach it";
    case "no-free-models":
      return "No free models right now";
    case "opencode-missing":
      return "Needs OpenCode";
  }
}

function agentRow(provider: SwarmProviderStatus): ChecklistRow {
  const meta = SWARM_PROVIDER_META[provider.provider];
  const base = {
    id: provider.provider,
    label: meta.label,
    step: "providers" as const,
  };
  if (!provider.enabled) {
    return { ...base, detail: "Off", state: "optional", fixLabel: "Turn on" };
  }
  const needsKey = provider.keyRequired && !provider.hasKey;
  if (needsKey) {
    return { ...base, detail: "Optional · no key", state: "optional", fixLabel: "Add key" };
  }
  const detail = testDetail(provider);
  if (detail === null) {
    return { ...base, detail: "Not tested yet", state: "untested", fixLabel: "Test" };
  }
  return provider.lastTest?.ok
    ? { ...base, detail, state: "ok", fixLabel: "Change" }
    : { ...base, detail, state: "problem", fixLabel: "Fix" };
}

function modelsRow(status: SwarmStatus): ChecklistRow {
  const count = status.models.available.length;
  if (count > 0) {
    return {
      id: "models",
      label: "Free models",
      detail: `${count} available`,
      state: "ok",
      step: "providers",
      fixLabel: "Change",
    };
  }
  const blocker = status.blockers.find(
    (entry) => entry.code === "all-models-cooling" || entry.code === "no-provider",
  );
  return {
    id: "models",
    label: "Free models",
    detail: blocker?.message ?? "None available yet",
    state: "problem",
    step: "providers",
    fixLabel: "Fix",
  };
}

function consentRow(status: SwarmStatus): ChecklistRow {
  const accepted = hasConsent(status);
  return {
    id: "consent",
    label: "Privacy consent",
    detail: accepted
      ? `Accepted${status.consent.acceptedAt !== null ? ` ${formatDate(status.consent.acceptedAt)}` : ""}`
      : "Required",
    state: accepted ? "ok" : "problem",
    step: "intro",
    fixLabel: accepted ? "Review" : "Fix",
  };
}

function checklistRows(status: SwarmStatus): ChecklistRow[] {
  return [
    opencodeRow(status),
    // Rows without a card here (local servers from a newer daemon) are covered by the models row.
    ...status.providers.filter((p) => p.provider in SWARM_PROVIDER_META).map(agentRow),
    modelsRow(status),
    consentRow(status),
  ];
}

function RowIcon({ state }: { readonly state: RowState }) {
  switch (state) {
    case "ok":
      return <CheckIcon className="size-3.5 text-success" aria-hidden />;
    case "problem":
      return <CircleAlertIcon className="size-3.5 text-warning" aria-hidden />;
    case "untested":
      return <CircleDashedIcon className="size-3.5 text-muted-foreground" aria-hidden />;
    case "optional":
      return <MinusIcon className="size-3.5 text-muted-foreground" aria-hidden />;
  }
}

const STATE_LABELS: Record<RowState, string> = {
  ok: "ready",
  problem: "needs attention",
  untested: "not tested",
  optional: "optional",
};

/**
 * What Swarm still needs, one row per piece (OpenCode, each free provider, free models, privacy).
 * Each row links to the setup step that changes it. Heads the wizard's last step and Settings.
 */
export function SwarmReadinessChecklist({
  status,
  onFix,
  essentialOnly = false,
}: {
  readonly status: SwarmStatus;
  /** Jump to the step that fixes a row; rows show no link when omitted. */
  readonly onFix?: (step: SwarmSetupStep) => void;
  /** Settings' short status: drop optional providers (they live under More options) and the consent row (the
   *  switch above says it). */
  readonly essentialOnly?: boolean;
}) {
  const rows = checklistRows(status).filter(
    (row) => !essentialOnly || (row.state !== "optional" && row.id !== "consent"),
  );
  return (
    <ul
      aria-label="Swarm readiness"
      className="divide-y divide-border/50 overflow-hidden rounded-lg bg-card ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5"
    >
      {rows.map((row) => (
        <li
          key={row.id}
          data-swarm-readiness-row={row.id}
          data-state={row.state}
          className="flex min-h-10 items-center gap-3 px-3 py-2 text-sm"
        >
          <span className="grid size-4 shrink-0 place-items-center">
            <RowIcon state={row.state} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="font-medium text-foreground">{row.label}</span>
            <span className="sr-only">, {STATE_LABELS[row.state]}</span>
            <span
              className={cn(
                "block truncate text-xs",
                row.state === "problem" ? "text-foreground/80" : "text-muted-foreground",
              )}
            >
              {row.detail}
            </span>
          </span>
          {onFix ? (
            <Button
              size="xs"
              variant="ghost"
              aria-label={`${row.fixLabel}: ${row.label}`}
              onClick={() => onFix(row.step)}
            >
              {row.fixLabel}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
