import type { AgentApprovalDecision, AgentApprovalOption, RequestId } from "@kora/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { memo, useEffect, type ComponentProps } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type Decide = (requestId: RequestId, decision: AgentApprovalDecision) => Promise<unknown>;

/** What a provider that sends no choices of its own gets. */
const FALLBACK_CHOICES: ReadonlyArray<AgentApprovalOption> = (
  [
    ["cancel", "Stop turn"],
    ["decline", "Decline"],
    ["acceptForSession", "Always allow this session"],
    ["accept", "Approve"],
  ] as const
).map(([decision, label]) => ({ decision, label }));

/** Approve leads, Decline is the visible way out, everything else stays quiet. */
function lookOf(choice: AgentApprovalOption): {
  variant: ComponentProps<typeof Button>["variant"];
  tone: string;
} {
  switch (choice.decision) {
    case "accept":
      return { variant: "default", tone: "font-medium" };
    case "decline":
      return {
        variant: "outline",
        tone: "text-destructive-foreground [:hover,[data-pressed]]:text-destructive-foreground",
      };
    default:
      return { variant: "ghost-muted", tone: choice.warning ? "text-warning" : "" };
  }
}

/** Escape answers the request from the keyboard with the lighter refusal: decline, else stop the turn. */
function useEscapeRefusal(
  choices: ReadonlyArray<AgentApprovalOption>,
  requestId: RequestId,
  busy: boolean,
  decide: Decide,
) {
  const refusal = (["decline", "cancel"] as const).find((decision) =>
    choices.some((choice) => choice.decision === decision),
  );
  useEffect(() => {
    if (!refusal || busy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      // An open menu, popover or dialog gets Escape first.
      const overlayOpen = document.querySelector(
        '[data-slot$="-popup"][data-open], [role="dialog"][aria-modal="true"]',
      );
      if (overlayOpen) return;
      event.preventDefault();
      void decide(requestId, refusal);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [refusal, busy, decide, requestId]);
}

function ChoiceButton(props: {
  choice: AgentApprovalOption;
  requestId: RequestId;
  busy: boolean;
  decide: Decide;
}) {
  const { choice } = props;
  const look = lookOf(choice);
  const button = (
    <Button
      size="micro"
      variant={look.variant}
      className={`font-normal sm:text-[11px] ${look.tone}`.trim()}
      disabled={props.busy}
      aria-label={choice.label}
      aria-description={choice.warning}
      data-approval-action={choice.decision}
      onClick={() => void props.decide(props.requestId, choice.decision)}
    >
      {choice.warning && <TriangleAlertIcon className="size-3 shrink-0" />}
      <span className="max-w-40 truncate">{choice.label}</span>
    </Button>
  );
  if (!choice.warning) return button;
  // A provider's caution (say, a prompt-injection risk on "allow always") sits in a tooltip so the row stays one line.
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="top" className="max-w-72 text-xs leading-snug">
        {choice.warning}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The answer buttons of the approval banner above the composer. */
export const ApprovalButtons = memo(function ApprovalButtons(props: {
  requestId: RequestId;
  busy: boolean;
  choices?: ReadonlyArray<AgentApprovalOption> | undefined;
  onDecide: Decide;
}) {
  const choices = props.choices ?? FALLBACK_CHOICES;
  useEscapeRefusal(choices, props.requestId, props.busy, props.onDecide);
  return choices.map((choice) => (
    <ChoiceButton
      key={choice.decision}
      choice={choice}
      requestId={props.requestId}
      busy={props.busy}
      decide={props.onDecide}
    />
  ));
});
