// The responder-rule chip in a group's header ("Auto", "Lead", "@mention"). A button when it can be changed.
import { AtSignIcon, CrownIcon, SparklesIcon } from "lucide-react";
import type { ComponentType } from "react";

import { cn } from "~/util/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { RULE_HELP, RULE_LABEL, RULE_SHORT, type ResponderRule } from "./groupModel";

const ICON: Record<ResponderRule, ComponentType<{ className?: string }>> = {
  auto: SparklesIcon,
  lead: CrownIcon,
  mention: AtSignIcon,
};

/** The chip's look, shared with a PopoverTrigger that IS the chip (header) so there is never a button inside a button. */
export function ruleChipClassName(clickable: boolean, extra?: string): string {
  return cn(
    "inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-muted/70 px-2 text-[11px] font-medium text-muted-foreground ring-1 ring-border/60 ring-inset transition-colors",
    clickable &&
      "cursor-pointer hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
    extra,
  );
}

export function RuleChipContent(props: { readonly rule: ResponderRule }) {
  const Icon = ICON[props.rule];
  return (
    <>
      <Icon className="size-3" aria-hidden />
      <span>{RULE_SHORT[props.rule]}</span>
    </>
  );
}

function RuleChip(props: {
  readonly rule: ResponderRule;
  readonly onClick?: () => void;
  readonly className?: string;
}) {
  const body = <RuleChipContent rule={props.rule} />;
  const cls = ruleChipClassName(Boolean(props.onClick), props.className);
  const help = `${RULE_LABEL[props.rule]}. ${RULE_HELP[props.rule]}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          props.onClick ? (
            <button
              type="button"
              className={cls}
              aria-label={`Replies: ${RULE_LABEL[props.rule]}`}
              data-rule-chip={props.rule}
              onClick={props.onClick}
            />
          ) : (
            <span className={cls} data-rule-chip={props.rule} />
          )
        }
      >
        {body}
      </TooltipTrigger>
      <TooltipPopup>{help}</TooltipPopup>
    </Tooltip>
  );
}
