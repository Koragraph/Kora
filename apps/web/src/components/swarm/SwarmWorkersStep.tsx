import type { HostId, SwarmStatus } from "@kora/contracts";
import { ChevronRightIcon, CloudIcon, KeyRoundIcon, LaptopIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  SWARM_WORKER_SOURCES,
  swarmWorkerSourceStates,
  type SwarmWorkerSource,
  type SwarmWorkerSourceState,
} from "../../util/swarm";
import { cn } from "../../util/utils";
import { swarmHost } from "../../atoms/swarm";
import { useAtomAction } from "../../atoms/use-atom-command";
import { Badge } from "../ui/badge";
import {
  SwarmLocalModelsPanel,
  SwarmPaidModelsPanel,
  SwarmSupplyModePicker,
} from "./SwarmSupplyPanels";
import { SwarmProvidersStep } from "./SwarmProvidersStep";
import { ZenRateLimitBanner } from "./SwarmQuickSetup";

const ICONS: Record<SwarmWorkerSource, typeof CloudIcon> = {
  free: CloudIcon,
  openrouter: KeyRoundIcon,
  local: LaptopIcon,
};

function stateBadge(state: SwarmWorkerSourceState): {
  readonly variant: "success" | "outline";
  readonly label: string;
} {
  return state.state === "on"
    ? { variant: "success", label: "On" }
    : state.state === "unavailable"
      ? { variant: "outline", label: "Update Kora" }
      : { variant: "outline", label: "Off" };
}

function SourceSection({
  source,
  state,
  children,
}: {
  readonly source: SwarmWorkerSource;
  readonly state: SwarmWorkerSourceState;
  readonly children: ReactNode;
}) {
  const meta = SWARM_WORKER_SOURCES[source];
  const Icon = ICONS[source];
  const badge = stateBadge(state);
  return (
    <section
      aria-label={meta.title}
      data-swarm-worker-source={source}
      data-state={state.state}
      className="space-y-3"
    >
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-foreground text-sm">{meta.title}</h3>
            <span className="text-muted-foreground text-xs">{meta.tag}</span>
            <Badge size="sm" variant={badge.variant} className="ms-auto">
              {badge.label}
            </Badge>
          </div>
          <p className="text-muted-foreground text-xs">{meta.body}</p>
          <p className="text-foreground/70 text-xs">{meta.privacy}</p>
        </div>
      </div>
      <div className="ps-6">{children}</div>
    </section>
  );
}

/**
 * Step 3: where workers run. Three first-class choices, any mix of them: free models (Zen, no
 * key), your own OpenRouter key (free models, plus paid ones under a per-task cap), and local models
 * (Ollama / LM Studio). One working choice is enough to continue. Enabled providers that were never
 * tested are tested on arrival, so a fresh install is not stuck on "Not tested".
 */
export function SwarmWorkersStep({
  hostId,
  status,
}: {
  readonly hostId: HostId;
  readonly status: SwarmStatus;
}) {
  const states = swarmWorkerSourceStates(status);
  const testProvider = useAtomAction(swarmHost.testProvider, {
    reportFailure: false,
    reportDefect: false,
  });
  const autoTested = useRef(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (autoTested.current) return;
    autoTested.current = true;
    for (const provider of status.providers) {
      const usable = provider.provider === "zen" || provider.hasKey;
      if (provider.enabled && usable && provider.lastTest === null) {
        void testProvider({ hostId, input: { provider: provider.provider } });
      }
    }
  }, [hostId, status.providers, testProvider]);

  return (
    <div className="space-y-5">
      <p className="text-muted-foreground text-sm">
        Pick where workers run. You can use more than one; Kora tries them in order and moves on
        when one is busy.
      </p>
      <SwarmSupplyModePicker hostId={hostId} status={status} />
      <SourceSection source="free" state={states.free}>
        <SwarmProvidersStep hostId={hostId} status={status} only={["zen"]} showKeyNote={false} />
        <ZenRateLimitBanner status={status} className="mt-3" />
      </SourceSection>
      <SourceSection source="openrouter" state={states.openrouter}>
        <div className="space-y-3">
          <SwarmProvidersStep
            hostId={hostId}
            status={status}
            only={["openrouter"]}
            showKeyNote={false}
          />
          <SwarmPaidModelsPanel hostId={hostId} status={status} />
        </div>
      </SourceSection>
      <SourceSection source="local" state={states.local}>
        <SwarmLocalModelsPanel hostId={hostId} status={status} />
      </SourceSection>
      <div className="space-y-2">
        <button
          type="button"
          aria-expanded={moreOpen}
          className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
          onClick={() => setMoreOpen((open) => !open)}
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", moreOpen && "rotate-90")}
            aria-hidden
          />
          More providers (Cerebras trial)
        </button>
        {moreOpen ? (
          <SwarmProvidersStep
            hostId={hostId}
            status={status}
            only={["cerebras"]}
            showKeyNote={false}
          />
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">
        Keys are stored in a private file in ~/.kora that only you can read. They are never sent to
        your lead agent and never shown again.
      </p>
    </div>
  );
}
