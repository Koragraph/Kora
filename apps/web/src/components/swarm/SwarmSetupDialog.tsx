import type { HostId, HostThreadRef, SwarmStatus } from "@kora/contracts";
import { HexagonIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import type { DraftId } from "../../stores/promptDraftStore";
import { useSwarmStatus } from "../../hooks/useSwarmStatus";
import {
  koragentReadiness,
  swarmWorkerBackend,
  swarmWorkerBackendLabel,
  swarmWorkerSourceStates,
} from "../../util/swarm";
import {
  closeSwarmSetup,
  useSwarmSetupStore,
  type SwarmSetupStep,
} from "../../stores/swarmSetupStore";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/stepper";
import { SwarmIntroStep } from "./SwarmIntroStep";
import { SwarmKoragentStep } from "./SwarmKoragentStep";
import { SwarmOpencodeStep } from "./SwarmOpencodeStep";
import { SwarmQuickSetup } from "./SwarmQuickSetup";
import { SwarmReadyStep } from "./SwarmReadyStep";
import { SwarmWorkersStep } from "./SwarmWorkersStep";

export interface SwarmSetupDialogProps {
  /** The host whose Swarm setup the dialog edits. */
  readonly hostId: HostId | null;
  /** "Start Swarm" on a dialog opened with a pending switch: commit agentMode "swarm" for `target`. */
  readonly onStartSwarm: (target: HostThreadRef | DraftId) => void;
  /** assistant lane: workers read/research in a scratch folder, never git/code — copy differs. */
  readonly isAssistantLane?: boolean;
}

const STEPS: readonly SwarmSetupStep[] = ["intro", "opencode", "providers", "ready"];
/** Step 2 is the worker program: OpenCode, or Koragent on the koragent backend. */
const stepLabels = (status: SwarmStatus | null) =>
  ["How it works", swarmWorkerBackendLabel(status), "Workers", "Ready"] as const;

/** Whether the user may continue past `step` (the last step instead gates "Start Swarm"). */
function stepComplete(step: SwarmSetupStep, status: SwarmStatus): boolean {
  switch (step) {
    case "intro":
      return (
        status.consent.acceptedVersion !== null &&
        status.consent.acceptedVersion >= status.consent.requiredVersion
      );
    case "opencode":
      return swarmWorkerBackend(status) === "koragent"
        ? koragentReadiness(status).ok
        : status.opencode.installed && status.opencode.versionOk;
    case "providers":
      // One working worker source: a provider that passed its test, or local models switched on.
      return (
        status.providers.some((provider) => provider.enabled && provider.lastTest?.ok === true) ||
        swarmWorkerSourceStates(status).local.state === "on"
      );
    case "ready":
      return status.ready;
  }
}

function setStep(step: SwarmSetupStep): void {
  useSwarmSetupStore.setState({ step });
}

/**
 * The 4-step Swarm setup wizard (intro + privacy → OpenCode → providers → ready). Open state lives
 * in `useSwarmSetupStore`. Closing early changes nothing; "Start Swarm" commits the pending switch
 * through `onStartSwarm`. Renders nothing on hosts without the `swarm` capability.
 */
export function SwarmSetupDialog({
  hostId,
  onStartSwarm,
  isAssistantLane = false,
}: SwarmSetupDialogProps) {
  const open = useSwarmSetupStore((state) => state.open);
  const variant = useSwarmSetupStore((state) => state.variant);
  const step = useSwarmSetupStore((state) => state.step);
  const pendingSwitch = useSwarmSetupStore((state) => state.pendingSwitch);
  const { supported, status } = useSwarmStatus(hostId);

  // A finished install moves on to the providers step by itself.
  const installPhase = status?.install.phase ?? null;
  const previousPhase = useRef(installPhase);
  useEffect(() => {
    const before = previousPhase.current;
    previousPhase.current = installPhase;
    if (
      open &&
      step === "opencode" &&
      before !== null &&
      before !== "succeeded" &&
      installPhase === "succeeded" &&
      status !== null &&
      stepComplete("opencode", status)
    ) {
      setStep("providers");
    }
  }, [installPhase, open, status, step]);

  if (!supported || hostId === null) return null;

  const index = Math.max(0, STEPS.indexOf(step));
  const isLast = index === STEPS.length - 1;
  const canContinue = status !== null && stepComplete(step, status);
  const blockedBefore = (target: number) =>
    status === null || STEPS.slice(0, target).some((entry) => !stepComplete(entry, status));

  const startSwarm = () => {
    const target = pendingSwitch?.target ?? null;
    closeSwarmSetup();
    if (target !== null) onStartSwarm(target);
  };
  const finishQuickSetup = () => {
    const switching = pendingSwitch !== null;
    startSwarm();
    toastManager.add({
      type: "success",
      title: switching ? "Stretch is on for this chat" : "Stretch is ready",
      description: switching
        ? "Your agent does small work itself and hands the rest to free models, then cheap Haiku or GPT Luna workers. The Stretch button turns it off."
        : "Turn it on for a chat with the Stretch button in the message box.",
    });
  };

  if (variant === "quick") {
    return (
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : closeSwarmSetup())}>
        <SwarmQuickSetup
          hostId={hostId}
          status={status}
          isAssistantLane={isAssistantLane}
          hasPendingSwitch={pendingSwitch !== null}
          onFinished={finishQuickSetup}
          onClose={closeSwarmSetup}
        />
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : closeSwarmSetup())}>
      <WizardPopup>
        <WizardHeader
          title="Set up Stretch"
          description={`Your lead agent plans and reviews on your plan; ${swarmWorkerBackendLabel(status)} workers on free, cheap or local models do the legwork in panes you can watch and steer.`}
        >
          <WizardSteps
            steps={stepLabels(status)}
            currentStep={index}
            onStepChange={(next) => {
              const target = STEPS[next];
              if (target && !(next > index && blockedBefore(next))) setStep(target);
            }}
            isStepDisabled={(next) => next > index && blockedBefore(next)}
          />
        </WizardHeader>
        <WizardPanel>
          {status === null ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner className="size-4" />
              Checking Swarm setup…
            </div>
          ) : step === "intro" ? (
            <SwarmIntroStep hostId={hostId} status={status} isAssistantLane={isAssistantLane} />
          ) : step === "opencode" ? (
            swarmWorkerBackend(status) === "koragent" ? (
              <SwarmKoragentStep hostId={hostId} status={status} />
            ) : (
              <SwarmOpencodeStep hostId={hostId} status={status} />
            )
          ) : step === "providers" ? (
            <SwarmWorkersStep hostId={hostId} status={status} />
          ) : (
            <SwarmReadyStep status={status} onFix={setStep} />
          )}
        </WizardPanel>
        <WizardFooter
          leading={
            <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <HexagonIcon className="size-3.5" aria-hidden />
              Step {index + 1} of {STEPS.length}
            </span>
          }
        >
          <Button
            variant="outline"
            onClick={() => (index === 0 ? closeSwarmSetup() : setStep(STEPS[index - 1]!))}
          >
            {index === 0 ? "Cancel" : "Back"}
          </Button>
          {!isLast ? (
            <Button disabled={!canContinue} onClick={() => setStep(STEPS[index + 1]!)}>
              Continue
            </Button>
          ) : pendingSwitch !== null ? (
            <Button disabled={!canContinue} onClick={startSwarm}>
              Start Swarm
            </Button>
          ) : (
            <Button onClick={closeSwarmSetup}>Done</Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
