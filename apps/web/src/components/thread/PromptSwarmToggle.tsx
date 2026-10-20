// The "Stretch" control inside the composer box, beside the attach button (it is the Swarm engine under a name that says
// what it is for). With it on, the agent does small work itself and hands the rest to the cheapest tier that can do it:
// free models first, then Claude Haiku / GPT Luna workers, so the user's usage lasts longer. Thread mode: `swarm`.
import type { HostThreadRef, ThreadAgentMode } from "@kora/contracts";
import { SparklesIcon } from "lucide-react";
import { memo, useRef, useState } from "react";

import { cn } from "~/util/utils";
import { SWARM_NO_GIT_DETAIL, type SwarmToggleAvailability } from "../../util/swarm";
import { SwarmActivityChip } from "../swarm/SwarmActivityChip";
import { Button } from "../ui/button";
import { Popover, PopoverPopup } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { promptFloatingLayerProps } from "./promptEventScope";

type PopoverKind = "blocked" | "no-git";

const SWARM_ON_TOOLTIP =
  "Stretch is on: your agent does small work itself and hands the rest to free models, then to cheap Haiku or GPT Luna workers, so your usage lasts longer. You can watch every worker. Click to turn it off.";

export const PromptSwarmToggle = memo(function PromptSwarmToggle(props: {
  readonly agentMode: ThreadAgentMode;
  readonly swarmAvailability: SwarmToggleAvailability;
  readonly swarmThreadRef: HostThreadRef | null;
  readonly onAgentModeChange: (mode: ThreadAgentMode) => void;
  /** Initialises git in the project folder; resolves to an error message, or null on success. */
  readonly onSetUpGit: (() => Promise<string | null>) | null;
  readonly compact: boolean;
}) {
  const { agentMode, swarmAvailability: availability, compact } = props;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [popover, setPopover] = useState<PopoverKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);

  if (availability.kind === "hidden") return null;

  const on = agentMode === "swarm";
  const blocked = availability.kind === "disabled";
  const noGit = availability.kind !== "disabled" && availability.noGit === true;
  const tooltip = on ? SWARM_ON_TOOLTIP : availability.tooltip;

  const turnOn = () => props.onAgentModeChange("swarm");
  const onClick = () => {
    if (on) {
      props.onAgentModeChange("chat");
    } else if (blocked) {
      setPopover("blocked");
    } else if (noGit) {
      setGitError(null);
      setPopover("no-git");
    } else {
      turnOn();
    }
  };

  const setUpGit = async () => {
    if (!props.onSetUpGit || busy) return;
    setBusy(true);
    setGitError(null);
    try {
      const error = await props.onSetUpGit();
      if (error !== null) {
        setGitError(error);
        return;
      }
      setPopover(null);
      turnOn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Tooltip open={popover !== null ? false : undefined}>
        <TooltipTrigger
          render={
            <Button
              ref={buttonRef}
              variant="chip"
              type="button"
              aria-pressed={on}
              aria-label="Stretch"
              aria-disabled={blocked || undefined}
              data-prompt-swarm=""
              data-prompt-agent-mode={agentMode}
              data-swarm-no-git={noGit ? "true" : undefined}
              onClick={onClick}
              className={cn(
                "inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--control-radius)] text-sm transition-colors duration-300 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-xs",
                compact ? "w-8 p-0" : "px-3",
                on
                  ? "bg-primary font-medium text-primary-foreground hover:bg-primary/90"
                  : "bg-foreground/5 text-secondary-label hover:text-foreground",
                blocked && "opacity-60",
              )}
            />
          }
        >
          <SparklesIcon aria-hidden className="size-4 shrink-0" />
          {compact ? null : <span>Stretch</span>}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-72 px-0.5">
          {tooltip}
        </TooltipPopup>
      </Tooltip>
      {on ? <SwarmActivityChip threadRef={props.swarmThreadRef} compact={compact} /> : null}
      <Popover
        open={popover !== null}
        onOpenChange={(open) => {
          if (!open) setPopover(null);
        }}
      >
        <PopoverPopup
          anchor={buttonRef}
          side="top"
          align="start"
          className="w-80"
          data-swarm-popover=""
          {...promptFloatingLayerProps}
        >
          {popover === "blocked" ? (
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Stretch isn't available here</p>
              <p className="text-xs text-muted-foreground">{availability.tooltip}</p>
            </div>
          ) : popover === "no-git" ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">This folder isn't a git repo</p>
              <p className="text-xs text-muted-foreground">{SWARM_NO_GIT_DETAIL}</p>
              {gitError ? <p className="text-xs text-destructive-foreground">{gitError}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  data-swarm-no-git-continue=""
                  onClick={() => {
                    setPopover(null);
                    turnOn();
                  }}
                >
                  Use without git
                </Button>
                {props.onSetUpGit ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-swarm-set-up-git=""
                    disabled={busy}
                    onClick={() => void setUpGit()}
                  >
                    {busy ? "Setting up…" : "Set up git here"}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </PopoverPopup>
      </Popover>
    </>
  );
});
