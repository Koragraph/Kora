import type { SwarmStatus } from "@kora/contracts";

import type { SwarmSetupStep } from "../../stores/swarmSetupStore";
import { SetupCheck } from "../onboarding/SetupCheck";
import { SwarmReadinessChecklist } from "./SwarmReadinessChecklist";

/** Step 4: the readiness checklist; each row's link jumps back to the step that fixes it. */
export function SwarmReadyStep({
  status,
  onFix,
}: {
  readonly status: SwarmStatus;
  readonly onFix: (step: SwarmSetupStep) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">
        {status.ready
          ? "Swarm is ready. Send a task as usual: your lead agent decides what to hand out, and each worker shows up as a pane you can watch, steer or stop."
          : "Almost there. Use Fix on a marked row to go back to the step that sorts it out."}
      </p>
      <SwarmReadinessChecklist status={status} onFix={onFix} />
      {!status.ready && status.blockers.length > 0 ? (
        <ul className="list-disc space-y-1 ps-5 text-foreground/80 text-xs">
          {status.blockers.map((blocker) => (
            <li key={blocker.code}>{blocker.message}</li>
          ))}
        </ul>
      ) : null}
      {/* The workers are only half of it: no working agent to lead (Claude Code, Codex or OpenCode) fails the first task. */}
      <SetupCheck problemsOnly />
    </div>
  );
}
