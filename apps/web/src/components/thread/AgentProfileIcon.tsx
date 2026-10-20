import { cn } from "~/util/utils";
import { AGENT_ICON_BY_AGENT } from "./agentIconUtils";
import { type AgentId } from "@kora/contracts";
import { agentProfileInitials } from "@kora/client-runtime/store/agent-profile-display";
import { type CSSProperties, memo } from "react";

const agentProfileIconCls1 =
  "relative isolate z-30 inline-flex shrink-0 items-center justify-center overflow-visible";
const agentProfileIconCls2 =
  "pointer-events-none absolute -left-0.5 -top-0.5 z-10 size-2 rounded-full";

export const AgentProfileIcon = memo(function AgentProfileIcon(props: {
  badgeContent?: "initials" | "none";
  accentColor?: string | undefined;
  indicatorBackground?: string;
  statusDotClassName?: string;
  badgeClassName?: string;
  iconClassName?: string;
  showBadge?: boolean;
  driverKind: AgentId;
  displayName: string;
  className?: string;
}) {
  const Icon = AGENT_ICON_BY_AGENT[props.driverKind] ?? null;
  const badgeContent = props.badgeContent ?? "initials";
  const accentStyle: CSSProperties | undefined = props.accentColor
    ? ({ ["--provider-accent"]: props.accentColor } as CSSProperties)
    : undefined;
  const indicatorBackground = props.indicatorBackground ?? "var(--card)";

  return (
    <span
      className={cn(agentProfileIconCls1, props.className)}
      data-agent-accent-color={props.accentColor}
      style={accentStyle}
    >
      {Icon ? (
        <Icon className={cn("size-5 shrink-0", props.iconClassName)} aria-hidden />
      ) : (
        <span className={cn("text-[10px] font-semibold leading-none", props.iconClassName)}>
          {agentProfileInitials(props.displayName)}
        </span>
      )}
      {props.statusDotClassName ? (
        <span
          aria-hidden
          style={{ boxShadow: `0 0 0 2px ${indicatorBackground}` }}
          className={cn(agentProfileIconCls2, props.statusDotClassName)}
        />
      ) : null}
      {props.showBadge ? (
        <span
          aria-hidden
          style={{ borderColor: indicatorBackground }}
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border px-0.5 text-[10px] font-semibold leading-none shadow-sm",
            props.accentColor
              ? "bg-[var(--provider-accent)] text-white"
              : "bg-card text-muted-foreground",
            props.badgeClassName,
          )}
        >
          {badgeContent === "initials" ? agentProfileInitials(props.displayName) : null}
        </span>
      ) : null}
    </span>
  );
});
