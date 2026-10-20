// Footer pieces of the composer: the Plan chip and the right-hand cluster (context ring + send/stop).

import { cn } from "~/util/utils";
import { PromptPrimaryActions } from "./PromptPrimaryActions";
import { Button } from "../ui/button";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import type { AgentTurnMode } from "@kora/contracts";
import type { ComponentProps } from "react";
import { PencilRulerIcon } from "lucide-react";

/** The Plan chip beside Swarm: on = the agent works in its own plan mode (it investigates, then hands back a plan). */
export function PromptFooterModeControls(props: {
  readonly showInteractionModeToggle: boolean;
  readonly interactionMode: AgentTurnMode;
  readonly compact?: boolean;
  readonly onToggleInteractionMode: () => void;
}) {
  if (!props.showInteractionModeToggle) return null;
  const planning = props.interactionMode === "plan";
  const label = planning
    ? "Plan mode: the agent plans and changes nothing. Click to turn it off."
    : "Plan mode: the agent investigates with the code graph and hands back a plan before changing anything.";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="chip"
            type="button"
            aria-pressed={planning}
            aria-label="Plan"
            data-prompt-plan=""
            onClick={props.onToggleInteractionMode}
            className={cn(
              "inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--control-radius)] text-sm transition-colors duration-300 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-xs",
              props.compact ? "w-8 p-0" : "px-3",
              planning
                ? "bg-primary font-medium text-primary-foreground hover:bg-primary/90"
                : "bg-foreground/5 text-secondary-label hover:text-foreground",
            )}
          />
        }
      >
        <PencilRulerIcon aria-hidden className="size-4 shrink-0" />
        {props.compact ? null : <span>Plan</span>}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}

export function PromptFooterPrimaryActions(props: {
  readonly actions: ComponentProps<typeof PromptPrimaryActions>;
}) {
  return (
    <>
      {/* The context ring is gone: context and plan usage both live in the usage sprite's details. */}
      <PromptPrimaryActions {...props.actions} />
    </>
  );
}
