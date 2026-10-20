import { type AgentReadinessState, agentReadiness } from "./agentRows";
import { getAgentVersionAdvisoryPresentation, getAgentVersionLabel } from "../agentStatus";
import type { DriverOption } from "../agentDriverMeta";
import { RedactedSensitiveText } from "../RedactedSensitiveText";
import { AgentPrefsForm } from "../AgentPrefsForm";
import { AgentModelsSection } from "../AgentModelsSection";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../../ui/tooltip";
import { toastManager } from "../../ui/toast";
import { DraftInput } from "../../ui/commit-input";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import { AGENT_ICON_BY_AGENT } from "../../thread/agentIconUtils";
import { AgentProfileIcon } from "../../thread/AgentProfileIcon";
import { forgetFirstRunChecks } from "../../onboarding/firstRunChecks";
import { ClaudeLoginButton } from "../../onboarding/ClaudeLoginButton";
import { cn } from "../../../util/utils";
import { fetchHealthReport } from "../../../util/healthCheck";
import { writeTextToClipboard } from "../../../hooks/useCopyText";
import { useHostHttpBaseUrl, usePrimaryHostId } from "../../../atoms/hosts";
import {
  readCustomModelEntries,
  type CustomModelDefinition,
  toCustomModelSetting,
} from "@kora/shared/modelOptions";
import {
  type AgentProfileConfig,
  type AgentProfileEnvVar,
  type AgentProfileId,
  type AgentStatus,
  type AgentModel,
  AgentId,
} from "@kora/contracts";
import { agentProfileInitials } from "@kora/client-runtime/store/agent-profile-display";
import { useEffect, useState, useMemo, useRef, useId } from "react";
import {
  ArrowUpCircleIcon,
  CircleDashedIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  LockOpenIcon,
  XCircleIcon,
  CheckIcon,
  MinusIcon,
  LockIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";

type Tab = "setup" | "models" | "environment";

/** Server models plus the saved custom list; a stale live custom row never outlives its settings entry. */
export function deriveAgentModelsForDisplay(input: {
  readonly liveModels: ReadonlyArray<AgentModel> | undefined;
  readonly customModels: ReadonlyArray<CustomModelDefinition>;
}): ReadonlyArray<AgentModel> {
  const live = input.liveModels ?? [];
  const server = live.filter((model) => !model.isCustom);
  const custom: AgentModel[] = input.customModels.map((entry) => {
    const liveCapabilities = live.find(
      (model) => model.isCustom && model.slug === entry.slug,
    )?.capabilities;
    return {
      capabilities: entry.capabilities ?? liveCapabilities ?? null,
      isCustom: true,
      name: entry.name,
      slug: entry.slug,
    };
  });
  return [...server, ...custom];
}

export interface AgentCardProps {
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  readonly onUpdate: (nextInstance: AgentProfileConfig) => void;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onResetToDefaults?: (() => void) | undefined;
  readonly driverOption: DriverOption | undefined;
  readonly liveProvider: AgentStatus | undefined;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly onRemove?: (() => void) | undefined;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly instance: AgentProfileConfig;
  readonly instanceId: AgentProfileId;
  readonly expanded: boolean;
}

const GLYPHS: Record<AgentReadinessState, { Icon: typeof CheckIcon; className: string }> = {
  ready: { Icon: CheckIcon, className: "text-success" },
  attention: { Icon: CircleAlertIcon, className: "text-warning" },
  error: { Icon: XCircleIcon, className: "text-destructive" },
  checking: { Icon: CircleDashedIcon, className: "text-muted-foreground" },
  off: { Icon: MinusIcon, className: "text-muted-foreground" },
};

function withoutEmpty(instance: AgentProfileConfig): AgentProfileConfig {
  const next: Record<string, unknown> = { ...instance };
  if (next.displayName === undefined || next.displayName === "") delete next.displayName;
  if (next.config === undefined || next.config === null) delete next.config;
  if (Array.isArray(next.environment) && next.environment.length === 0) delete next.environment;
  if (next.environment === undefined) delete next.environment;
  return next as unknown as AgentProfileConfig;
}

function ClaudeCardLogin() {
  const primaryHostId = usePrimaryHostId();
  const httpBaseUrl = useHostHttpBaseUrl(primaryHostId);
  if (!httpBaseUrl) return null;
  return (
    <div data-agent-card-login className="px-3 pb-3 ps-12">
      <ClaudeLoginButton
        httpBaseUrl={httpBaseUrl}
        doneText="Signed in. Updating this page…"
        onLoggedIn={() => {
          forgetFirstRunChecks();
          void fetchHealthReport(httpBaseUrl, {
            only: ["claude-cli", "claude-auth"],
            probe: false,
          }).catch(() => undefined);
        }}
      />
    </div>
  );
}

const ENV_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
let envRowSeed = 0;
interface EnvRow extends AgentProfileEnvVar {
  readonly rowId: number;
}
const toRows = (vars: ReadonlyArray<AgentProfileEnvVar>): EnvRow[] =>
  vars.map((entry) => ({ ...entry, rowId: ++envRowSeed }));
const sameVars = (a: ReadonlyArray<AgentProfileEnvVar>, b: ReadonlyArray<AgentProfileEnvVar>) =>
  JSON.stringify(a) === JSON.stringify(b);

function AgentEnvEditor(props: {
  value: ReadonlyArray<AgentProfileEnvVar>;
  onChange: (next: ReadonlyArray<AgentProfileEnvVar>) => void;
}) {
  const [rows, setRows] = useState<EnvRow[]>(() => toRows(props.value));
  const previousProps = useRef(props.value);
  const published = useRef<ReadonlyArray<AgentProfileEnvVar> | null>(null);

  // Take outside changes, but not the echo of what this editor just published.
  useEffect(() => {
    const incoming = props.value;
    if (sameVars(incoming, previousProps.current)) return;
    previousProps.current = incoming;
    if (published.current && sameVars(incoming, published.current)) return;
    setRows(toRows(incoming));
  }, [props.value]);

  const commit = (next: EnvRow[]) => {
    setRows(next);
    const out: AgentProfileEnvVar[] = [];
    for (const row of next) {
      const pristine =
        row.name === "" && row.value === "" && row.sensitive && row.valueRedacted === undefined;
      if (pristine) continue;
      if (!ENV_NAME.test(row.name.trim())) return; // an invalid row blocks publishing
      const { rowId: _ignored, ...entry } = row;
      out.push({ ...entry, name: row.name.trim() });
    }
    published.current = out;
    props.onChange(out);
  };

  const edit = (id: number, patch: Partial<EnvRow>) =>
    commit(rows.map((row) => (row.rowId === id ? { ...row, ...patch } : row)));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Passed to the agent's CLI when Kora starts it. Secrets are stored apart and never sent back
        to the app.
      </p>
      <div className="flex flex-col gap-1.5">
        {rows.map((row, index) => {
          const n = index + 1;
          const label = row.name || String(n);
          const redacted = row.valueRedacted === true;
          return (
            <div key={row.rowId} className="flex flex-wrap items-center gap-1.5">
              <DraftInput
                size="sm"
                spellCheck={false}
                className="w-full font-mono sm:w-44"
                placeholder="VARIABLE_NAME"
                aria-label={`Environment variable name ${n}`}
                value={row.name}
                onCommit={(name) => edit(row.rowId, { name })}
              />
              <DraftInput
                size="sm"
                spellCheck={false}
                autoComplete="off"
                type={row.sensitive ? "password" : "text"}
                className="min-w-0 flex-1 font-mono"
                placeholder={redacted ? "Stored secret — type to replace" : "value"}
                aria-label={`Environment variable value ${n}`}
                value={redacted ? "" : row.value}
                onCommit={(value) => {
                  if (redacted && value === "") return;
                  const { valueRedacted: _drop, ...rest } = row;
                  commit(
                    rows.map((r) =>
                      r.rowId === row.rowId ? { ...rest, value, rowId: row.rowId } : r,
                    ),
                  );
                }}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost-muted"
                      size="icon-micro"
                      aria-pressed={row.sensitive}
                      aria-label={`Mark environment variable ${label} as sensitive`}
                      className={cn(row.sensitive && "text-foreground")}
                      onClick={() => {
                        const { valueRedacted: _drop, ...rest } = row;
                        commit(
                          rows.map((r) =>
                            r.rowId === row.rowId
                              ? row.sensitive
                                ? { ...rest, sensitive: false, rowId: row.rowId }
                                : { ...row, sensitive: true }
                              : r,
                          ),
                        );
                      }}
                    />
                  }
                >
                  {row.sensitive ? (
                    <LockIcon className="size-3" />
                  ) : (
                    <LockOpenIcon className="size-3" />
                  )}
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {row.sensitive ? "Secret, stored apart" : "Plain text"}
                </TooltipPopup>
              </Tooltip>
              <Button
                variant="ghost-muted"
                size="icon-micro"
                aria-label={`Remove environment variable ${label}`}
                className="hover:text-destructive"
                onClick={() => commit(rows.filter((r) => r.rowId !== row.rowId))}
              >
                <XIcon className="size-3" />
              </Button>
            </div>
          );
        })}
      </div>
      <Button
        variant="outline"
        size="xs"
        className="self-start"
        onClick={() =>
          setRows((existing) => [
            ...existing,
            ...toRows([{ name: "", value: "", sensitive: true } as AgentProfileEnvVar]),
          ])
        }
      >
        <PlusIcon className="size-3.5" />
        Add variable
      </Button>
    </div>
  );
}

/** One line under a card whose name alone does not say how it differs from another card. */
const AGENT_NOTES: Readonly<Record<string, string>> = {
  "acp-opencode":
    "The same OpenCode, driven over its Agent Client Protocol: one long-running process per chat instead of a fresh run each turn.",
};

export function AgentCard(props: AgentCardProps) {
  const { instanceId, instance, driverOption, liveProvider, expanded } = props;
  const panelId = useId();
  const [tab, setTab] = useState<Tab>("setup");
  // Bumped on Reset so the buffered text fields start over from the stored values at once.
  const [resetEpoch, setResetEpoch] = useState(0);

  const readiness = agentReadiness(instance, liveProvider);
  const enabled = readiness.state !== "off";
  const driverId = instance.driver as string;
  const displayName = instance.displayName?.trim() || driverOption?.label || driverId;
  const versionLabel = getAgentVersionLabel(liveProvider?.version);
  const advisory = getAgentVersionAdvisoryPresentation(liveProvider?.versionAdvisory);
  const email =
    enabled && liveProvider?.auth.status === "authenticated"
      ? liveProvider.auth.email?.trim()
      : undefined;
  const knownDriver =
    driverOption !== undefined || AGENT_ICON_BY_AGENT[instance.driver as AgentId] !== undefined
      ? (instance.driver as AgentId)
      : null;
  const customModels = useMemo(
    () =>
      driverId === "antigravity"
        ? []
        : readCustomModelEntries(
            (instance.config as { customModels?: unknown } | undefined)?.customModels,
          ),
    [driverId, instance.config],
  );
  const models = useMemo(
    () => deriveAgentModelsForDisplay({ liveModels: liveProvider?.models, customModels }),
    [liveProvider?.models, customModels],
  );
  const hiddenSet = new Set(props.hiddenModels);
  const visibleCount = models.filter((model) => !hiddenSet.has(model.slug)).length;
  const extraInstance = (instanceId as string) !== driverId;

  const update = (next: AgentProfileConfig) => props.onUpdate(withoutEmpty({ ...next }));
  const Glyph = GLYPHS[readiness.state];
  const statusText =
    readiness.detail && readiness.state !== "ready"
      ? `${readiness.headline} — ${readiness.detail}`
      : readiness.headline;

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "setup", label: "Setup" },
    ...(driverOption ? [{ id: "models" as const, label: "Models" }] : []),
    { id: "environment", label: "Environment" },
  ];
  const activeTab = tabs.some((candidate) => candidate.id === tab) ? tab : "setup";

  const copyUpdateCommand = async (command: string) => {
    try {
      await writeTextToClipboard(command, "update command");
      toastManager.add({
        type: "success",
        title: `${displayName} update command copied`,
        description: "Run it in a terminal when you are ready to update.",
      });
    } catch (cause) {
      toastManager.add({
        description: cause instanceof Error ? cause.message : "An error occurred.",
        title: `Could not copy ${displayName} update command`,
        type: "error",
      });
    }
  };

  return (
    <li
      data-agent-card={instanceId}
      data-state={readiness.state}
      className={cn(
        "overflow-hidden rounded-lg bg-card ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5",
        expanded && "ring-black/10 dark:ring-white/10",
      )}
    >
      <div className="flex min-h-14 items-center gap-3 px-3 py-2.5">
        <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">
          <Glyph.Icon className={cn("size-3.5", Glyph.className)} />
        </span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-sm text-left focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => props.onExpandedChange(!expanded)}
        >
          {knownDriver ? (
            <AgentProfileIcon
              driverKind={knownDriver}
              displayName={displayName}
              className="size-5"
              iconClassName="size-4 text-foreground/85"
              badgeContent="none"
            />
          ) : driverOption?.icon ? (
            <driverOption.icon className="size-4 shrink-0" />
          ) : (
            <span className="text-[10px] font-semibold">{agentProfileInitials(displayName)}</span>
          )}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-2">
              <span
                className={cn(
                  "truncate text-sm font-medium",
                  enabled ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {displayName}
              </span>
              {extraInstance ? (
                <code className="text-[10px] text-muted-foreground">{instanceId}</code>
              ) : null}
              {versionLabel ? (
                <code className="text-[11px] text-muted-foreground/80">{versionLabel}</code>
              ) : null}
              {driverOption?.badgeLabel ? (
                <Badge variant="warning" size="sm">
                  {driverOption.badgeLabel}
                </Badge>
              ) : null}
            </span>
            <span
              className={cn(
                "mt-0.5 line-clamp-2 text-xs [overflow-wrap:anywhere]",
                readiness.state === "attention" || readiness.state === "error"
                  ? "text-foreground/80"
                  : "text-muted-foreground",
              )}
            >
              {statusText}
            </span>
            {AGENT_NOTES[driverId] ? (
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {AGENT_NOTES[driverId]}
              </span>
            ) : null}
          </span>
          {enabled && models.length > 0 ? (
            <span className="text-xs text-muted-foreground tabular-nums max-sm:hidden">
              {visibleCount} model{visibleCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </button>
        {!enabled ? (
          <Button
            variant="outline"
            size="xs"
            aria-label={`Turn on ${displayName}`}
            onClick={() => update({ ...instance, enabled: true })}
          >
            Turn on
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-hidden
          tabIndex={-1}
          className="text-muted-foreground"
          onClick={() => props.onExpandedChange(!expanded)}
        >
          <ChevronDownIcon
            className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
          />
        </Button>
      </div>

      {instance.driver === ("claude" as AgentId) &&
      enabled &&
      liveProvider?.auth.status === "unauthenticated" ? (
        <ClaudeCardLogin />
      ) : null}

      {expanded ? (
        <div id={panelId} className="border-t border-border/60">
          <div
            role="tablist"
            aria-label={`${displayName} settings`}
            className="flex items-stretch gap-5 border-b border-border/60 px-4"
          >
            {tabs.map((entry) => {
              const selected = entry.id === activeTab;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={cn(
                    "relative cursor-pointer py-2 text-xs font-medium",
                    selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setTab(entry.id)}
                >
                  {entry.label}
                  <span
                    className={cn(
                      "absolute inset-x-0 -bottom-px h-0.5 rounded-full",
                      selected ? "bg-foreground" : "bg-transparent",
                    )}
                  />
                </button>
              );
            })}
          </div>
          <div className="p-4" role="tabpanel">
            {activeTab === "setup" ? (
              <div className="flex flex-col gap-4" key={resetEpoch}>
                <div className="grid gap-x-6 gap-y-3 sm:grid-cols-[144px_minmax(0,1fr)] sm:items-center">
                  <span className="text-xs font-medium text-muted-foreground">
                    Name in the picker
                  </span>
                  <DraftInput
                    key={resetEpoch}
                    aria-label="Name in the picker"
                    size="sm"
                    className="sm:max-w-72"
                    placeholder={driverOption?.label ?? "Name"}
                    value={instance.displayName ?? ""}
                    onCommit={(next) => {
                      const trimmed = next.trim();
                      const { displayName: _old, ...rest } = instance;
                      update(trimmed ? { ...rest, displayName: trimmed } : rest);
                    }}
                  />
                  {email ? (
                    <>
                      <span className="text-xs font-medium text-muted-foreground">Account</span>
                      <RedactedSensitiveText
                        value={email}
                        hideTooltip="Click to hide email"
                        revealTooltip="Click to reveal email"
                        ariaLabel="Toggle account email visibility"
                      />
                    </>
                  ) : null}
                  {advisory ? (
                    <>
                      <span className="text-xs font-medium text-muted-foreground">Update</span>
                      <span className="flex flex-wrap items-center gap-2 text-xs">
                        <ArrowUpCircleIcon
                          className={cn(
                            "size-3.5",
                            advisory.emphasis === "strong"
                              ? "text-warning"
                              : "text-muted-foreground",
                          )}
                        />
                        {advisory.detail}
                        {advisory.updateCommand ? (
                          <Button
                            variant="outline"
                            size="xs"
                            aria-label={`Copy ${displayName} update command`}
                            onClick={() => void copyUpdateCommand(advisory.updateCommand!)}
                          >
                            Copy command
                          </Button>
                        ) : null}
                      </span>
                    </>
                  ) : null}
                </div>

                {driverOption ? (
                  <div className="overflow-hidden rounded-md px-3 ring-1 ring-black/5 dark:ring-white/5 [&>*+*]:border-t [&>*+*]:border-border/50">
                    <AgentPrefsForm
                      definition={driverOption}
                      value={instance.config}
                      idPrefix={`agent-${instanceId}`}
                      variant="settings"
                      onChange={(config) => {
                        const { config: _old, ...rest } = instance;
                        update(config === undefined ? rest : { ...rest, config });
                      }}
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    This agent uses <code>{driverId}</code>, which this build of Kora does not ship.
                    Its settings are kept as they are.
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {props.onResetToDefaults ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      // Keep the focused field from committing its half-typed text on the way to Reset.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setResetEpoch((epoch) => epoch + 1);
                        props.onResetToDefaults?.();
                      }}
                    >
                      Reset to defaults
                    </Button>
                  ) : null}
                  {props.onRemove ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={`Remove ${instanceId}`}
                      className="hover:text-destructive"
                      onClick={props.onRemove}
                    >
                      Remove
                    </Button>
                  ) : null}
                  <span className="flex-1" />
                  {enabled ? (
                    <Button
                      variant="outline"
                      size="xs"
                      aria-label={`Turn off ${displayName}`}
                      onClick={() => update({ ...instance, enabled: false })}
                    >
                      Turn off
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {activeTab === "models" ? (
              <div className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">
                  Star the models you reach for, hide the rest. Favorites, hidden models and order
                  live on this device; models you add are saved with the agent.
                </p>
                <AgentModelsSection
                  instanceId={instanceId}
                  driverKind={knownDriver}
                  models={models}
                  customModels={customModels}
                  hiddenModels={props.hiddenModels}
                  favoriteModels={props.favoriteModels}
                  modelOrder={props.modelOrder}
                  onChange={(next) =>
                    // An empty list is kept on purpose: it means "the user cleared the list".
                    update({
                      ...instance,
                      config: {
                        ...(instance.config as object | undefined),
                        customModels: next.map(toCustomModelSetting),
                      },
                    })
                  }
                  onHiddenModelsChange={props.onHiddenModelsChange}
                  onFavoriteModelsChange={props.onFavoriteModelsChange}
                  onModelOrderChange={props.onModelOrderChange}
                />
              </div>
            ) : null}

            {activeTab === "environment" ? (
              <AgentEnvEditor
                value={instance.environment ?? []}
                onChange={(vars) => {
                  const { environment: _old, ...rest } = instance;
                  const kept = vars.filter((entry) => entry.name.trim() !== "");
                  update(kept.length > 0 ? { ...rest, environment: kept } : rest);
                }}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}
