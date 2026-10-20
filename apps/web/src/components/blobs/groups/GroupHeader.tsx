// The group chat's top bar. Left: "# name" and the members' faces (each opens that blob). Right: the responder-rule chip
// (click to change who answers) and Edit. The thread title in the middle stays the app's own ChatHeader.
import { CheckIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";

import { BlobAvatar, type BlobVisualState } from "~/components/blobs/avatar";
import { cn } from "~/util/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { RuleChipContent, ruleChipClassName } from "./RuleChip";
import {
  RESPONDER_RULES,
  RULE_HELP,
  RULE_LABEL,
  joinNames,
  type GroupMember,
  type GroupWire,
  type ResponderRule,
} from "./groupModel";

export function GroupHeaderIdentity(props: {
  readonly group: GroupWire;
  /** Lead first (groupMembers()). */
  readonly members: ReadonlyArray<GroupMember>;
  /** Members with a turn running right now. */
  readonly speakingIds?: ReadonlySet<string>;
  readonly onOpenMember: (blobId: string) => void;
}) {
  const { group, members } = props;
  return (
    <div
      className="-ms-1 flex h-9 min-w-0 shrink-0 items-center gap-2.5 ps-1 [-webkit-app-region:no-drag]"
      data-group-header-identity
    >
      <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
        <span aria-hidden className="text-muted-foreground">
          #
        </span>
        <span className="truncate font-semibold text-foreground" data-group-header-name>
          {group.name}
        </span>
      </span>
      <span
        className="flex items-center -space-x-1.5"
        role="group"
        aria-label={`Members: ${joinNames(members.map((m) => m.name))}`}
      >
        {members.map((m) => {
          const speaking = props.speakingIds?.has(m.id) === true;
          const state: BlobVisualState = speaking ? "working" : "idle";
          return (
            <Tooltip key={m.id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    data-group-member={m.id}
                    aria-label={`${m.name}${m.id === group.leadId ? ", lead" : ""}. Open`}
                    onClick={() => props.onOpenMember(m.id)}
                    className={cn(
                      "relative grid size-7 place-items-center rounded-full bg-card ring-2 ring-background transition-transform hover:z-10 hover:-translate-y-px focus-visible:z-10 focus-visible:outline-none focus-visible:ring-ring",
                      speaking && "ring-foreground/50",
                    )}
                  />
                }
              >
                <BlobAvatar
                  outfit={m.outfit}
                  chief={m.chief}
                  chiefScale={1}
                  state={state}
                  size={24}
                  eyesFollowCursor={false}
                />
              </TooltipTrigger>
              <TooltipPopup>
                {m.name}
                {m.id === group.leadId ? " · lead" : m.title ? ` · ${m.title}` : ""}
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </span>
    </div>
  );
}

export function GroupHeaderActions(props: {
  readonly group: GroupWire;
  readonly onChangeRule: (rule: ResponderRule) => void;
  readonly onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 ps-1 [-webkit-app-region:no-drag]"
      data-group-header-actions
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={ruleChipClassName(true)}
          data-rule-chip={props.group.rule}
          aria-label={`Replies: ${RULE_LABEL[props.group.rule]}`}
          title={`${RULE_LABEL[props.group.rule]}. ${RULE_HELP[props.group.rule]}`}
        >
          <RuleChipContent rule={props.group.rule} />
        </PopoverTrigger>
        <PopoverPopup
          align="end"
          className="w-72"
          viewportClassName="py-1.5 [--viewport-inline-padding:--spacing(1.5)]"
        >
          <div role="radiogroup" aria-label="Who answers" className="flex w-full flex-col">
            {RESPONDER_RULES.map((rule) => {
              const on = props.group.rule === rule;
              return (
                <button
                  key={rule}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-rule-menu-option={rule}
                  onClick={() => {
                    if (!on) props.onChangeRule(rule);
                    setOpen(false);
                  }}
                  className="flex items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
                    {on ? <CheckIcon className="size-3.5" /> : null}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{RULE_LABEL[rule]}</span>
                    <span className="block text-[11.5px] leading-snug text-muted-foreground">
                      {RULE_HELP[rule]}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </PopoverPopup>
      </Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-group-edit
              aria-label="Edit group"
              onClick={props.onEdit}
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <SettingsIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup>Edit group</TooltipPopup>
      </Tooltip>
    </div>
  );
}
