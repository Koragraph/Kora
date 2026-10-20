import {
  useScopedSettingSource,
  useUpdateScopedPrefs,
  useScopedPrefsMixed,
  useScopedPrefs,
} from "./useScopedPrefs";
import { searchableSetting } from "./prefsSearch";
import {
  PREFS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  PrefsSection,
  PrefsRow,
} from "./prefsLayout";
import { usePrefsScope } from "./PrefsScopeContext";
import { toastManager } from "../ui/toast";
import { SelectTrigger, SelectPopup, SelectValue, SelectItem, Select } from "../ui/select";
import { accessModeOptions, accessModeConfig } from "../thread/accessModeConfig";
import { TraitsPicker } from "../thread/TraitsPicker";
import { AgentModelPicker } from "../thread/AgentModelPicker";
import { getCustomModelOptionsByInstance } from "../../modelPick";
import { mergeHostPrefs, useClientPrefs } from "../../hooks/usePrefs";
import { EMPTY_DAEMON_AGENTS } from "../../atoms/server";
import {
  resolveDefaultAgentModelPick,
  deriveAgentProfileEntries,
  sortAgentProfileEntries,
  applyAgentProfilePrefs,
} from "../../agentProfiles";
import { createModelPick } from "@kora/shared/modelOptions";
import { DEFAULT_DAEMON_PREFS, type AgentProfileId } from "@kora/contracts";
import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useKoraSurfaceOn } from "../../koraSurface";

const DEFAULT_MODEL_ROW = searchableSetting("default-model");
const PERMISSIONS_ROW = searchableSetting("default-permissions");
const COMPACT_ROW = searchableSetting("claude-compact-at");
const SECTION = searchableSetting("project-defaults");

const noop = () => {};

const COMPACT_LABELS = {
  "200k": "200k (recommended)",
  "400k": "400k",
  full: "Model's full window",
} as const;

export function ProjectDefaultsPrefs() {
  const navigate = useNavigate();
  const { scope, target, targets, connectedHosts } = usePrefsScope();
  const settings = useScopedPrefs();
  const clientPrefs = useClientPrefs();
  const update = useUpdateScopedPrefs();

  const modelMixed = useScopedPrefsMixed(["defaultModelSelection"]);
  const permissionsMixed = useScopedPrefsMixed(["defaultRuntimeMode"]);
  const compactMixed = useScopedPrefsMixed(["claudeCompactAt"]);
  const modelSource = useScopedSettingSource(["defaultModelSelection"]);
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  // Settings > Kora is hidden while Kora is coming soon: don't point at it.
  const koraOn = useKoraSurfaceOn();

  const representative =
    connectedHosts.find((host) => host.hostId === target?.hostId) ?? connectedHosts[0];
  const providers = representative?.daemonConfig?.providers ?? EMPTY_DAEMON_AGENTS;

  const pick = useMemo(
    () => resolveDefaultAgentModelPick(providers, settings.defaultModelSelection),
    [providers, settings.defaultModelSelection],
  );
  const entries = useMemo(
    () =>
      sortAgentProfileEntries(
        applyAgentProfilePrefs(deriveAgentProfileEntries(providers), settings),
      ),
    [providers, settings],
  );
  const modelOptions = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, pick?.instanceId, pick?.model),
    [pick, providers, settings],
  );
  const activeEntry = pick
    ? entries.find((entry) => entry.instanceId === pick.instanceId)
    : undefined;

  // A model may only be chosen when every selected target can run it.
  const disabledReason = useCallback(
    (instanceId: AgentProfileId, model: string): string | null => {
      const source = entries.find((entry) => entry.instanceId === instanceId);
      for (const candidate of targets) {
        const host = connectedHosts.find((entry) => entry.hostId === candidate.hostId);
        const config = host?.daemonConfig;
        const ok = (() => {
          if (!config) return false;
          const hostEntries = applyAgentProfilePrefs(
            deriveAgentProfileEntries(config.providers),
            config.settings,
          );
          const hostEntry = hostEntries.find((entry) => entry.instanceId === instanceId);
          if (!hostEntry || !hostEntry.enabled || !hostEntry.isAvailable) return false;
          if (source && hostEntry.driverKind !== source.driverKind) return false;
          const options = getCustomModelOptionsByInstance(
            mergeHostPrefs(config.settings, clientPrefs),
            config.providers,
          ).get(instanceId);
          const found = options?.find((option) => option.slug === model);
          return !!found && !found.isUnavailable;
        })();
        if (!ok) {
          return `This model is unavailable on ${host?.label ?? "a selected environment"}. Select that environment to choose its model separately.`;
        }
      }
      return null;
    },
    [clientPrefs, connectedHosts, entries, targets],
  );

  const writeModel = (
    instanceId: AgentProfileId,
    model: string,
    options?: Parameters<typeof createModelPick>[2],
  ) => {
    const reason = disabledReason(instanceId, model);
    if (reason) {
      toastManager.add({ type: "error", title: "Default model not saved", description: reason });
      return;
    }
    update({ defaultModelSelection: createModelPick(instanceId, model, options) });
  };

  const automatic =
    connectedHosts.length > 0 &&
    !modelMixed &&
    modelSource !== "project" &&
    settings.defaultModelSelection === null;

  const modelControl =
    pick && activeEntry ? (
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
        <AgentModelPicker
          triggerClassName={PREFS_PICKER_TRIGGER_CLASSNAME}
          modelOptionsByInstance={modelOptions}
          activeInstanceId={pick.instanceId}
          instanceEntries={entries}
          triggerVariant="outline"
          lockedProvider={null}
          model={pick.model}
          {...(modelMixed ? { triggerLabel: "Mixed" } : {})}
          whyModelDisabled={disabledReason}
          onOpenProviderSetup={(instanceId) => {
            if (!representative) return;
            void navigate({
              to: "/settings/providers" as never,
              search: { hostId: representative.hostId, instanceId } as never,
            });
          }}
          onInstanceModelChange={(instanceId, model) => writeModel(instanceId, model)}
        />
        {modelMixed ? null : (
          <TraitsPicker
            provider={activeEntry.driverKind}
            instanceId={pick.instanceId}
            models={activeEntry.models}
            model={pick.model}
            prompt=""
            onPromptChange={noop}
            modelOptions={pick.options ?? null}
            allowPromptInjectedEffort={false}
            planModeEnabled={settings.planModeEnabled}
            triggerVariant="outline"
            onModelOptionsChange={(options) =>
              writeModel(pick.instanceId, pick.model, options ?? undefined)
            }
          />
        )}
      </div>
    ) : (
      <span className="text-sm text-muted-foreground">No providers available</span>
    );

  return (
    <PrefsSection id={SECTION.id} title="Starting a chat">
      <PrefsRow
        id={DEFAULT_MODEL_ROW.id}
        title="Model"
        serverScoped
        settingKeys={["defaultModelSelection"]}
        mixed={modelMixed}
        description={
          projectScope
            ? "Model for new chats in this project."
            : `What new Code threads start on (Claude starts on Sonnet unless you pick another). A project can choose its own.${koraOn ? " Blobs have their own model in Settings, Kora." : ""}`
        }
        status={automatic ? "Automatic until you pick one" : undefined}
        resetAction={
          settings.defaultModelSelection ? (
            <SettingResetButton
              label="default model"
              onClick={() => update({ defaultModelSelection: null })}
            />
          ) : null
        }
        control={modelControl}
      />
      <PrefsRow
        control={
          <Select
            value={permissionsMixed ? null : settings.defaultRuntimeMode}
            onValueChange={(value) => {
              if (value && value in accessModeConfig) {
                update({ defaultRuntimeMode: value as keyof typeof accessModeConfig });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Default permissions">
              <SelectValue>
                {permissionsMixed ? "Mixed" : accessModeConfig[settings.defaultRuntimeMode].label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false} align="end">
              {accessModeOptions.map((mode) => (
                <SelectItem key={mode} value={mode} hideIndicator className="min-w-64 py-2">
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">{accessModeConfig[mode].label}</span>
                    <span className="text-xs leading-4 text-muted-foreground">
                      {accessModeConfig[mode].description}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
        resetAction={
          settings.defaultRuntimeMode !== DEFAULT_DAEMON_PREFS.defaultRuntimeMode ? (
            <SettingResetButton
              onClick={() =>
                update({ defaultRuntimeMode: DEFAULT_DAEMON_PREFS.defaultRuntimeMode })
              }
              label="default permissions"
            />
          ) : null
        }
        description={
          projectScope
            ? "Permissions for new chats in this project."
            : "How much new chats may do without asking. A project can choose its own."
        }
        settingKeys={["defaultRuntimeMode"]}
        mixed={permissionsMixed}
        id={PERMISSIONS_ROW.id}
        title="Permissions"
        serverScoped
      />
      <PrefsRow
        id={COMPACT_ROW.id}
        title="Compact long conversations at"
        serverScoped
        settingKeys={["claudeCompactAt"]}
        mixed={compactMixed}
        description="Claude re-reads the whole conversation on every message, so a long one costs more each time. 200k keeps long chats cheap; 400k and the full window (1M on Opus and Sonnet 5.5) remember more before summarizing but use your plan faster. Applies to Claude sessions and workers started from now on."
        resetAction={
          settings.claudeCompactAt !== DEFAULT_DAEMON_PREFS.claudeCompactAt ? (
            <SettingResetButton
              onClick={() => update({ claudeCompactAt: DEFAULT_DAEMON_PREFS.claudeCompactAt })}
              label="compaction size"
            />
          ) : null
        }
        control={
          <Select
            value={compactMixed ? null : settings.claudeCompactAt}
            onValueChange={(value) => {
              if (value === "200k" || value === "400k" || value === "full") {
                update({ claudeCompactAt: value });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Compact long conversations at">
              <SelectValue>
                {compactMixed ? "Mixed" : COMPACT_LABELS[settings.claudeCompactAt]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false} align="end">
              {(["200k", "400k", "full"] as const).map((value) => (
                <SelectItem key={value} value={value}>
                  {COMPACT_LABELS[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </PrefsSection>
  );
}
