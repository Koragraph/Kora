import { useRelativeTimeTick, PrefsPageContainer, PrefsSection, PrefsRow } from "./prefsLayout";
import { searchableSetting } from "./prefsSearch";
import { Switch } from "../ui/switch";
import { useClientPrefs, useUpdateClientPrefs } from "../../hooks/usePrefs";
import { Spinner } from "../ui/spinner";
import { Button } from "../ui/button";
import { cn, thisComputer } from "../../util/utils";
import {
  formatResetPhrase,
  activePlanLimit,
  planWindowViews,
  formatDuration,
} from "../../util/planUsage";
import { refreshPlanUsage } from "../../util/planUsageRefresh";
import { useHostHttpBaseUrl, usePrimaryHostId, usePrimaryHost } from "../../atoms/hosts";
import type { AgentUsageLimits, AgentStatus } from "@kora/contracts";
import { useCallback, useEffect, useState, useRef } from "react";

const AGENT_KIND_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
};
const TONE_BAR: Record<"normal" | "warning" | "critical", string> = {
  normal: "bg-muted-foreground/70",
  warning: "bg-warning",
  critical: "bg-destructive",
};

function checkedPhrase(checkedAt: string, now: number): string {
  const t = Date.parse(checkedAt);
  if (!Number.isFinite(t)) return "";
  const ago = now - t;
  return ago < 60_000 ? "Checked just now" : `Checked ${formatDuration(ago)} ago`;
}

export function AgentUsageCard(props: {
  provider: Pick<AgentStatus, "instanceId" | "displayName" | "driver">;
  limits: AgentUsageLimits | null | undefined;
  now: number;
}) {
  const { limits, now } = props;
  const name =
    props.provider.displayName ?? AGENT_KIND_LABELS[props.provider.driver] ?? props.provider.driver;
  const views = planWindowViews(limits, now);
  const limit = activePlanLimit(limits, now);
  const empty = !limits
    ? "Not checked yet."
    : limits.unavailable?.reason === "unsupported"
      ? `No plan limits reported. ${name} is signed out, or bills through an API key or cloud provider.`
      : views.length === 0 && !limit
        ? limits.unavailable?.reason === "probeFailed"
          ? `Couldn't read ${name}'s usage. Is ${name} installed and signed in?`
          : "No usage reported yet."
        : null;
  return (
    <div
      data-testid={`usage-card-${props.provider.instanceId}`}
      className="space-y-3 rounded-lg bg-card px-4 py-3.5 ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="font-medium text-[13px] text-foreground">{name}</span>
          {limits?.plan ? (
            <span className="rounded-full bg-muted px-1.5 py-px text-[10.5px] text-muted-foreground">
              {limits.plan}
            </span>
          ) : null}
        </div>
        {limits ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {checkedPhrase(limits.checkedAt, now)}
          </span>
        ) : null}
      </div>
      {limit ? (
        <div role="alert" className="text-pretty text-[12px] text-destructive">
          Usage limit reached
          {limit.resetsAt !== null ? ` · ${formatResetPhrase(limit.resetsAt, now)}` : ""}. Switch
          the thread to another model or provider to keep going.
        </div>
      ) : null}
      {views.length > 0 ? (
        <ul className="space-y-2.5" aria-label={`${name} plan windows`}>
          {views.map((view) => (
            <li key={view.id} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3 text-[12px]">
                <span className="truncate text-foreground/90">{view.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  <span className="text-foreground/90">{Math.round(view.usedPercent)}% used</span>
                  {view.hasReset ? (
                    <span className="ml-2">reset since last check</span>
                  ) : view.resetsAt !== null ? (
                    <span className="ml-2">{formatResetPhrase(view.resetsAt, now)}</span>
                  ) : null}
                </span>
              </div>
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted/70"
                aria-valuenow={Math.round(view.usedPercent)}
                aria-label={`${view.label} used`}
                aria-valuemax={100}
                role="progressbar"
                aria-valuemin={0}
              >
                <div
                  className={cn("h-full rounded-full", TONE_BAR[view.tone])}
                  style={{ width: `${view.usedPercent}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {empty ? <p className="text-[12px] text-muted-foreground">{empty}</p> : null}
    </div>
  );
}

const SAVINGS_ROW = searchableSetting("kora-savings");

/** "Kora saved you $X" in the usage sign's details, and the honest note on what that number is. */
function KoraSavingsRow() {
  const show = useClientPrefs((p) => p.showKoraSavings);
  const update = useUpdateClientPrefs();
  return (
    <PrefsRow
      id={SAVINGS_ROW.id}
      title={SAVINGS_ROW.title}
      description={
        <>
          Adds &ldquo;Kora saved you&rdquo; to the usage sign&apos;s details: for this thread, this
          week and all time, across Claude Code, Codex, OpenCode and Antigravity. Kora works it out
          on this Mac from its own logs, pricing what it kept out of the conversation at each
          model&apos;s own provider&apos;s list price (Claude at Anthropic&apos;s, GPT at
          OpenAI&apos;s, Gemini at Google&apos;s). Prices refresh daily from the public models.dev
          list, so a new model needs no Kora update; a model with no public price is left out, never
          guessed. It is the API value of the work saved, not money back: a subscription is a flat
          fee.
        </>
      }
      control={
        <Switch
          aria-label={SAVINGS_ROW.title}
          checked={show}
          onCheckedChange={(checked) => void update({ showKoraSavings: checked })}
        />
      }
    />
  );
}

/** A reading older than this is re-checked when the page opens. */
const AUTO_CHECK_AFTER_MS = 5 * 60_000;

export function UsagePrefsPanel() {
  const primary = usePrimaryHost();
  const httpBaseUrl = useHostHttpBaseUrl(usePrimaryHostId());
  const now = useRelativeTimeTick(30_000);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Claude and Codex always have a card; Antigravity only once the daemon has read its quota (agy installed).
  const providers = (primary?.daemonConfig?.providers ?? []).filter(
    (p) =>
      p.driver === "claude" ||
      p.driver === "codex" ||
      (p.driver === "antigravity" && !!p.usageLimits),
  );

  const refresh = useCallback(
    async (force = true) => {
      if (!httpBaseUrl) return;
      setRefreshing(true);
      setError(null);
      try {
        await refreshPlanUsage(httpBaseUrl, undefined, undefined, force);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Usage refresh failed.");
      } finally {
        setRefreshing(false);
      }
    },
    [httpBaseUrl],
  );

  // Opening the page checks once when a provider has no reading yet (or only an old one), so nobody has to find
  // Refresh to see their limits. The daemon throttles probes, so a quick back-and-forth costs nothing.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (autoChecked.current || !httpBaseUrl || providers.length === 0) return;
    autoChecked.current = true;
    const stale = providers.some((p) => {
      const at = p.usageLimits ? Date.parse(p.usageLimits.checkedAt) : Number.NaN;
      return !Number.isFinite(at) || Date.now() - at > AUTO_CHECK_AFTER_MS;
    });
    if (stale) void refresh(false);
  }, [httpBaseUrl, providers, refresh]);

  return (
    <PrefsPageContainer className="gap-10">
      <PrefsSection
        id="plan-limits"
        title="Plan limits"
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={refreshing || !httpBaseUrl}
            onClick={() => void refresh(true)}
          >
            {refreshing ? <Spinner className="size-3" /> : null}
            {refreshing ? "Checking…" : "Refresh"}
          </Button>
        }
      >
        <div className="space-y-3">
          <p className="px-1 text-[12px] text-muted-foreground">
            Read from Claude Code, Codex and Antigravity on {thisComputer()} — the same numbers
            their own <code>/usage</code> shows. Checking sends no prompt and uses no tokens.
          </p>
          {error ? <p className="px-1 text-[12px] text-destructive">{error}</p> : null}
          {providers.length === 0 ? (
            <p className="px-1 text-[12px] text-muted-foreground">Connecting to Kora…</p>
          ) : (
            providers.map((provider) => (
              <AgentUsageCard
                key={provider.instanceId}
                provider={provider}
                limits={provider.usageLimits}
                now={now}
              />
            ))
          )}
        </div>
      </PrefsSection>
      <PrefsSection id="kora-savings-section" title="Savings">
        <KoraSavingsRow />
      </PrefsSection>
      <PrefsSection id="context-help" title="Context window" variant="plain">
        <div className="space-y-2 px-1 text-[12px] text-muted-foreground">
          <p>
            The ring beside Send shows how full the current conversation is. Hover it for the exact
            count, the auto-compact point, and the provider&apos;s cost estimate for the session
            when it gives one.
          </p>
          <p>
            In a Claude thread, type <code>/compact</code> to summarize the conversation and free
            space without starting over. Codex and Antigravity manage their own context.
          </p>
        </div>
      </PrefsSection>
    </PrefsPageContainer>
  );
}
