import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { Button } from "../ui/button";
import { cn, terminalAppName, thisComputer } from "../../util/utils";
import { FixWithCopy } from "../onboarding/SetupCheck";
import { formatAgentIdLabel } from "../../agentModels";
import type { AgentProfileId, AgentStatus } from "@kora/contracts";
import { memo } from "react";
import { InfoIcon, XIcon } from "lucide-react";

export function getAgentStatusBannerKey(status: AgentStatus | null): string | null {
  if (!status || status.status === "ready" || status.status === "disabled") return null;
  // Antigravity checks saved credentials when a session starts, so "unknown" after a restart is not a failure.
  const antigravityWarmingUp =
    status.driver === "antigravity" && status.installed && status.status === "warning";
  if (antigravityWarmingUp && status.auth.status === "unknown") {
    return null;
  }
  return [status.instanceId, status.status, status.auth.status, status.message ?? ""].join(
    "\u0000",
  );
}

export function shouldShowAgentStatusBanner(
  status: AgentStatus | null,
  dismissedBannerKey: string | null,
): boolean {
  const key = getAgentStatusBannerKey(status);
  return key !== null && key !== dismissedBannerKey;
}

export function hasAgentSetup(status: AgentStatus): boolean {
  const { setup } = status;
  return (
    status.driver === "antigravity" || setup?.canInstall === true || setup?.canAuthenticate === true
  );
}

function agentName(status: AgentStatus): string {
  return status.displayName?.trim() || formatAgentIdLabel(status.driver);
}

/** The Terminal command that signs each CLI agent in, where there is one. */
const SIGN_IN_COMMAND: Readonly<Record<string, string>> = {
  claude: "claude auth login",
  codex: "codex login",
  opencode: "opencode auth login",
};

export function getAgentStatusMessage(status: AgentStatus): string {
  // Kept intact so the agent's own error reads the same in the banner and the picker.
  if (status.message) return status.message;
  const name = agentName(status);
  const setup = hasAgentSetup(status);
  if (!status.installed && setup) {
    return `Open agent setup to install ${formatAgentIdLabel(status.driver)} on ${thisComputer()}.`;
  }
  if (status.auth.status === "unauthenticated") {
    if (!setup) {
      const command = SIGN_IN_COMMAND[status.driver];
      return command
        ? `In ${terminalAppName()}, run \`${command}\`, then send again.`
        : `Sign ${name} in from its own app, then send again.`;
    }
    if (status.driver === "antigravity") {
      return "Open agent setup to sign in with Google.";
    }
    return "Open agent setup to sign in.";
  }
  if (status.status === "ready") return `${name} has no models available.`;
  if (status.status === "error") return `${name} isn't available right now.`;
  return `${name} may not work right now.`;
}

export const AgentStatusBanner = memo(function AgentStatusBanner(props: {
  onDismiss: () => void;
  onOpenProviderSetup?: (instanceId: AgentProfileId) => void;
  status: AgentStatus | null;
}) {
  const { status, onDismiss, onOpenProviderSetup } = props;
  if (!status || getAgentStatusBannerKey(status) === null) return null;

  const name = agentName(status);
  const warning = status.status === "warning";
  const title =
    status.auth.status === "unauthenticated"
      ? `${name} isn't signed in`
      : status.status === "error"
        ? `${name} isn't available`
        : `${name} needs attention`;
  const message = getAgentStatusMessage(status);

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100vw-2rem)] pt-3">
      <div
        role="alert"
        data-variant={warning ? "warning" : "error"}
        className={cn(
          "alert-glass relative inline-flex items-center gap-3 rounded-xl border py-3 pr-10 pl-3.5 text-sm text-card-foreground",
          warning
            ? "border-warning/32 [&_svg]:text-warning"
            : "border-destructive/32 text-destructive-foreground [&_svg]:text-destructive",
        )}
      >
        <InfoIcon className="size-4 shrink-0" />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="font-medium">{title}</div>
          {/* A Terminal fix shows its command as code with a copy button. */}
          {message.includes("`") ? (
            <FixWithCopy fix={message} />
          ) : (
            <Tooltip>
              <TooltipTrigger render={<div className="line-clamp-3 text-muted-foreground" />}>
                {message}
              </TooltipTrigger>
              <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
                {message}
              </TooltipPopup>
            </Tooltip>
          )}
          {onOpenProviderSetup && hasAgentSetup(status) ? (
            <Button
              size="xs"
              variant="link"
              className="justify-start px-0 text-foreground"
              onClick={() => onOpenProviderSetup(status.instanceId)}
            >
              Open agent setup
            </Button>
          ) : null}
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Dismiss ${name} notice`}
          className="absolute top-2 right-2 size-6 text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
});
