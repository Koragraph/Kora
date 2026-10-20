// The sidebar footer's usage sign: the overview. It holds up the WEEK ("N% left this week") and its popover lists every
// agent's plan; the composer's sign is the open thread's 5-hour session. It follows the open thread's agent, else the
// first plan that has data.
import { useMemo } from "react";
import type { AgentStatus } from "@kora/contracts";

import { useDaemonConfigs } from "../../atoms/entities";
import { useHostHttpBaseUrl, usePrimaryHostId } from "../../atoms/hosts";
import { ComposerUsageSign } from "../thread/UsageSignIndicator";
import { USAGE_DRIVERS, usageReading } from "../thread/usageSign.logic";

/** The provider whose plan the footer shows: the preferred driver's when it has a reading, else the first that does. */
export function pickUsageProvider(
  providers: ReadonlyArray<AgentStatus>,
  preferredDriver: string | null | undefined,
  model: string | null | undefined,
  now: number,
): AgentStatus | null {
  const order = [preferredDriver, ...USAGE_DRIVERS].filter((d): d is string => !!d);
  for (const driver of order) {
    const status = providers.find((p) => p.driver === driver);
    if (!status) continue;
    if (usageReading({ driver, model, limits: status.usageLimits, now })) return status;
  }
  return null;
}

export function SidebarUsage(props: {
  readonly driver: string | null | undefined;
  readonly model: string | null | undefined;
  readonly onOpenUsage: () => void;
}) {
  const hostId = usePrimaryHostId();
  const configs = useDaemonConfigs();
  const httpBaseUrl = useHostHttpBaseUrl(hostId);
  const providers = useMemo(
    () => (hostId ? (configs.get(hostId)?.providers ?? []) : []) as ReadonlyArray<AgentStatus>,
    [configs, hostId],
  );
  const status = useMemo(
    () => pickUsageProvider(providers, props.driver, props.model, Date.now()),
    [providers, props.driver, props.model],
  );
  if (!status) return null;
  return (
    <ComposerUsageSign
      driver={status.driver}
      httpBaseUrl={httpBaseUrl}
      limits={status.usageLimits}
      model={status.driver === props.driver ? props.model : null}
      onOpenUsage={props.onOpenUsage}
      providers={providers}
      scope="overview"
      showLabel
    />
  );
}
