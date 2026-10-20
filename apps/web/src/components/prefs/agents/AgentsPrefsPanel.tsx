import { partitionAgentRows, buildAgentRows, type AgentRow } from "./agentRows";
import { AgentCard } from "./AgentCard";
import { searchableSetting } from "../prefsSearch";
import { PrefsPageContainer, PrefsSection } from "../prefsLayout";
import { getDriverOption, DRIVER_OPTIONS } from "../agentDriverMeta";
import { buildAgentProfileUpdatePatch } from "../PrefsPanels.logic";
import { useUpdateClientPrefs, useUpdateHostPrefs, useHostPrefs } from "../../../hooks/usePrefs";
import { EMPTY_DAEMON_AGENTS, daemonHost } from "../../../atoms/server";
import { DEFAULT_UNIFIED_PREFS } from "@kora/contracts/clientPrefs";
import {
  defaultProfileIdForDriver,
  type AgentProfileConfig,
  type AgentProfileId,
  AgentId,
  type HostId,
} from "@kora/contracts";
import { useState } from "react";
import * as Result from "effect/Result";
import * as Arr from "effect/Array";
import { useAtomValue } from "@effect/atom-react";
import { thisComputer } from "../../../util/utils";

function withoutInstanceKey<V>(
  record: Readonly<Record<AgentProfileId, V>> | undefined,
  key: AgentProfileId,
): Record<AgentProfileId, V> {
  const next = { ...record } as Record<AgentProfileId, V>;
  delete next[key];
  return next;
}

/**
 * Settings › Agents: every coding agent Kora can lead a thread with or hand work to, split into
 * the ones turned on and the ones turned off. Each is a card with a readiness line; opening it
 * shows Setup, Models and Environment. Kora is local-only, so this always edits this Mac's daemon.
 */
export function AgentsPrefsPanel(props: {
  readonly hostId: HostId;
  readonly targetInstanceId?: AgentProfileId | undefined;
}) {
  return (
    <PrefsPageContainer width="readable" className="gap-8">
      <AgentsPrefsContent
        key={`${props.hostId}:${props.targetInstanceId ?? ""}`}
        hostId={props.hostId}
        targetInstanceId={props.targetInstanceId}
      />
    </PrefsPageContainer>
  );
}

function AgentsPrefsContent({
  hostId,
  targetInstanceId,
}: {
  readonly hostId: HostId;
  readonly targetInstanceId?: AgentProfileId | undefined;
}) {
  const settings = useHostPrefs(hostId);
  const updatePrefs = useUpdateHostPrefs(hostId);
  const updateClientPrefs = useUpdateClientPrefs();
  const agentList = useAtomValue(daemonHost.providersValueAtom(hostId)) ?? EMPTY_DAEMON_AGENTS;
  const [expanded, setExpanded] = useState<ReadonlySet<AgentProfileId>>(
    () => new Set(targetInstanceId ? [targetInstanceId] : []),
  );

  // Cursor only shows once its CLI has been found: most machines never have it.
  const visibleDrivers = DRIVER_OPTIONS.map((option) => option.value).filter(
    (driver) =>
      driver !== "cursor" ||
      agentList.some(
        (provider) => provider.instanceId === defaultProfileIdForDriver(AgentId.make("cursor")),
      ),
  );
  const rows = buildAgentRows(settings, visibleDrivers);
  const { on, off } = partitionAgentRows(rows);
  const targetMissing =
    targetInstanceId !== undefined && !rows.some((row) => row.instanceId === targetInstanceId);

  const setRowExpanded = (instanceId: AgentProfileId, open: boolean) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(instanceId);
      else next.delete(instanceId);
      return next;
    });

  const updateInstance = (row: AgentRow, next: AgentProfileConfig) =>
    updatePrefs(
      buildAgentProfileUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
      }),
    );

  const removeInstance = (instanceId: AgentProfileId) =>
    updatePrefs({
      providerInstances: withoutInstanceKey(settings.providerInstances, instanceId),
    });

  const resetToDefaults = (driver: AgentId) => {
    type LegacyAgentPrefs = (typeof settings.providers)[keyof typeof settings.providers];
    const defaults = DEFAULT_UNIFIED_PREFS.providers as Record<
      string,
      LegacyAgentPrefs | undefined
    >;
    const shipped = defaults[driver];
    if (shipped === undefined) return;
    updatePrefs({
      providers: { ...settings.providers, [driver]: shipped } as typeof settings.providers,
      providerInstances: withoutInstanceKey(
        settings.providerInstances,
        defaultProfileIdForDriver(driver),
      ),
    });
  };

  const updateModelPreferences = (
    instanceId: AgentProfileId,
    next: {
      readonly modelOrder: ReadonlyArray<string>;
      readonly hiddenModels: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutInstanceKey(settings.providerModelPreferences, instanceId);
    updateClientPrefs({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : { ...rest, [instanceId]: { hiddenModels, modelOrder } },
    });
  };

  const updateFavoriteModels = (
    instanceId: AgentProfileId,
    nextFavorites: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(
        Arr.filterMap(nextFavorites, (slug) => {
          const trimmed = slug.trim();
          return trimmed.length > 0 ? Result.succeed(trimmed) : Result.failVoid;
        }),
      ),
    ];
    updateClientPrefs({
      favorites: [
        ...(settings.favorites ?? []).filter((favorite) => favorite.provider !== instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  const renderCard = (row: AgentRow) => {
    const preferences = settings.providerModelPreferences?.[row.instanceId] ?? {
      modelOrder: [],
      hiddenModels: [],
    };
    const favoriteModels = Arr.filterMap(settings.favorites ?? [], (favorite) =>
      favorite.provider === row.instanceId ? Result.succeed(favorite.model) : Result.failVoid,
    );
    return (
      <AgentCard
        key={row.instanceId}
        instanceId={row.instanceId}
        instance={row.instance}
        driverOption={getDriverOption(row.driver)}
        liveProvider={agentList.find((provider) => provider.instanceId === row.instanceId)}
        expanded={expanded.has(row.instanceId)}
        onExpandedChange={(open) => setRowExpanded(row.instanceId, open)}
        onUpdate={(next) => updateInstance(row, next)}
        onRemove={row.isDefault ? undefined : () => removeInstance(row.instanceId)}
        onResetToDefaults={
          row.isDefault && row.isDirty ? () => resetToDefaults(row.driver) : undefined
        }
        hiddenModels={preferences.hiddenModels}
        favoriteModels={favoriteModels}
        modelOrder={preferences.modelOrder}
        onHiddenModelsChange={(hiddenModels) =>
          updateModelPreferences(row.instanceId, { ...preferences, hiddenModels })
        }
        onFavoriteModelsChange={(next) => updateFavoriteModels(row.instanceId, next)}
        onModelOrderChange={(modelOrder) =>
          updateModelPreferences(row.instanceId, { ...preferences, modelOrder })
        }
      />
    );
  };

  return (
    <>
      <p className="-mb-2 max-w-xl text-sm text-muted-foreground">
        The coding agents on {thisComputer()}. Agents that are on show up in the model picker, can
        lead a chat and can be handed work as workers. Where each one runs from (program path,
        accounts, endpoints) lives in Engines.
      </p>
      {targetMissing ? (
        <p className="text-sm text-muted-foreground">
          That agent is no longer set up here. Pick another below.
        </p>
      ) : null}
      <PrefsSection
        id={searchableSetting("providers").id}
        title={`On · ${on.length}`}
        variant="plain"
      >
        {on.length > 0 ? (
          <ul className="space-y-2" aria-label="Agents that are on">
            {on.map(renderCard)}
          </ul>
        ) : (
          <p className="py-2 text-sm text-muted-foreground">
            No agent is on. Turn one on below to start a chat.
          </p>
        )}
      </PrefsSection>
      {off.length > 0 ? (
        <PrefsSection title={`Off · ${off.length}`} variant="plain">
          <ul className="space-y-2" aria-label="Agents that are off">
            {off.map(renderCard)}
          </ul>
        </PrefsSection>
      ) : null}
    </>
  );
}
