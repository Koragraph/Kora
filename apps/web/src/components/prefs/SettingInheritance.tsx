import {
  isProjectScopedSettingKey,
  type ProjectOverrideEntry,
  type ScopedPrefsTarget,
} from "./scopedPrefs";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { PopoverTrigger, PopoverPopup, Popover } from "../ui/popover";
import { HostMachineIcon } from "../HostMachineIcon";
import { cn, thisComputer } from "../../util/utils";
import type { HostPresentation } from "../../atoms/hosts";
import { resolveHostMachineKind, DEFAULT_DAEMON_PREFS, type DaemonPrefs } from "@kora/contracts";
import { CheckIcon } from "lucide-react";
import * as Equal from "effect/Equal";

export type SettingInheritanceState =
  | "environment"
  | "overridden"
  | "inherited"
  | "default"
  | "mixed";

export interface SettingOverridingProject extends ProjectOverrideEntry {
  readonly open: () => void;
  readonly label: string;
}

interface InheritanceLayer {
  key: "project" | "environment" | "built-in";
  label: string;
  value: string;
  effective: boolean;
  set: boolean;
}

const WRITING_MODE_LABELS: Record<string, string> = {
  custom: "Custom instructions",
  conventional_commits: "Conventional Commits",
  repo_conventions: "Repository conventions",
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatValue(key: keyof DaemonPrefs, value: unknown): string {
  if (value === null || value === undefined) {
    if (key === "sidebarAutoSettleAfterDays") return "Never";
    if (key === "defaultModelSelection") return "Automatic";
    return "Not set";
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") {
    return key === "sidebarAutoSettleAfterDays" ? plural(value, "day") : String(value);
  }
  if (typeof value === "string") return value === "" ? "Empty" : value;
  if (Array.isArray(value)) return plural(value.length, "item");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.model === "string") return record.model;
    if (typeof record.mode === "string") return WRITING_MODE_LABELS[record.mode] ?? record.mode;
  }
  return "Custom";
}

/** The resolution chain for one key on one target: project override, environment value, built-in default. */
export function settingInheritanceLayers(
  target: ScopedPrefsTarget,
  hostPrefs: DaemonPrefs,
  key: keyof DaemonPrefs,
): readonly InheritanceLayer[] {
  const scoped = isProjectScopedSettingKey(key as string);
  const fromProject = scoped && target.sources[key as keyof typeof target.sources] === "project";
  const hostValue = hostPrefs[key];
  const defaultValue = DEFAULT_DAEMON_PREFS[key];
  const environmentSet = !Equal.equals(hostValue, defaultValue);
  const projectLayer: InheritanceLayer[] =
    target.projectId !== null && scoped
      ? [
          {
            effective: fromProject,
            set: fromProject,
            value: fromProject ? formatValue(key, target.settings[key]) : "Inherits",
            label: "Project",
            key: "project",
          },
        ]
      : [];
  const environmentLayer: InheritanceLayer = {
    effective: !fromProject && environmentSet,
    set: environmentSet,
    value: environmentSet ? formatValue(key, hostValue) : "Inherits",
    label: target.label,
    key: "environment",
  };
  const builtInLayer: InheritanceLayer = {
    effective: !fromProject && !environmentSet,
    set: true,
    value: formatValue(key, defaultValue),
    label: "Default",
    key: "built-in",
  };
  const layers: InheritanceLayer[] = [...projectLayer, environmentLayer, builtInLayer];
  return layers;
}

const PILL_LABELS: Record<SettingInheritanceState, string> = {
  default: "default",
  environment: thisComputer(),
  inherited: "inherited",
  overridden: "project",
  mixed: "mixed",
};

const PILL_CLASSES: Record<SettingInheritanceState, string> = {
  overridden: "border-foreground/30 text-foreground",
  mixed: "border-warning/40 text-warning",
  environment: "border-border text-foreground/75 hover:text-foreground",
  default: "border-border/60 text-muted-foreground hover:text-foreground",
  inherited: "border-border/60 text-muted-foreground hover:text-foreground",
};

export function SettingInheritance(props: {
  state: SettingInheritanceState;
  summary: string;
  targets: readonly ScopedPrefsTarget[];
  environments: readonly Pick<HostPresentation, "hostId" | "daemonConfig">[];
  keys: readonly (keyof DaemonPrefs)[];
  overridingProjects?: readonly SettingOverridingProject[];
  onClearOverrides?: (entries: readonly ProjectOverrideEntry[]) => void;
}) {
  const { state, targets, environments, keys, overridingProjects = [], onClearOverrides } = props;
  const key = keys[0];
  if (key === undefined || targets.length === 0) return null;

  const summary =
    overridingProjects.length > 0
      ? `${props.summary} · ${plural(overridingProjects.length, "project override")}`
      : props.summary;
  const scoped = isProjectScopedSettingKey(key as string);

  const pill = (
    <button
      type="button"
      data-setting-source={state}
      aria-label={`${summary}. Show where this value comes from`}
      className={cn(
        "inline-flex h-4 cursor-pointer items-center rounded-full border px-1.5 text-[10px] leading-none font-medium tracking-wide transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        PILL_CLASSES[state],
      )}
    >
      {PILL_LABELS[state]}
    </button>
  );

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={pill} />} />
        <TooltipPopup side="top">{summary}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" className="w-72 max-w-[calc(100vw-2rem)]" viewportClassName="p-0">
        <div className="divide-y divide-border/60">
          {targets.map((target) => {
            const config = environments.find((env) => env.hostId === target.hostId)?.daemonConfig;
            if (!config) return null;
            const layers = settingInheritanceLayers(target, config.settings, key);
            const overriding = overridingProjects.filter((entry) => entry.hostId === target.hostId);
            return (
              <section key={`${target.hostId}:${target.projectId ?? ""}`} className="px-3 py-2.5">
                <h4 className="flex items-center gap-1.5 pb-1.5 text-xs font-medium text-muted-foreground">
                  <HostMachineIcon kind={resolveHostMachineKind(config)} className="size-3.5" />
                  <span className="truncate">{target.label}</span>
                </h4>
                <ol className="text-sm">
                  {layers.map((layer) => (
                    <li
                      className={cn(
                        "grid grid-cols-[1fr_auto] gap-x-3 rounded-md px-2 py-1",
                        layer.effective && "bg-foreground/6",
                      )}
                      key={layer.key}
                    >
                      <span
                        className={cn(
                          layer.effective ? "font-medium text-foreground" : "text-muted-foreground",
                          !layer.set && "opacity-60",
                        )}
                      >
                        {layer.key === "environment" ? "Environment" : layer.label}
                      </span>
                      <span
                        className={cn(
                          layer.effective ? "text-foreground" : "text-muted-foreground",
                          "flex items-center gap-1.5 tabular-nums",
                          !layer.set && "opacity-60",
                        )}
                      >
                        <span className="max-w-32 truncate">{layer.value}</span>
                        {layer.effective ? (
                          <CheckIcon className="size-3.5 text-control-checked" />
                        ) : (
                          <span className="size-3.5" aria-hidden />
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
                {overriding.length > 0 ? (
                  <div className="mt-2 border-t border-border/60 pt-2">
                    <div className="flex justify-between gap-12 px-2 text-xs text-muted-foreground">
                      <span>Overridden by</span>
                      {onClearOverrides ? (
                        <button
                          type="button"
                          className="cursor-pointer font-medium text-foreground hover:underline"
                          onClick={() => onClearOverrides(overriding)}
                        >
                          {overriding.length === 1 ? "Reset it" : "Reset all"}
                        </button>
                      ) : null}
                    </div>
                    <ul className="text-sm">
                      {overriding.map((entry) => {
                        const overrideRecord = scoped
                          ? (config.settings.projectSettingsOverrides?.[entry.projectId] as
                              | Record<string, unknown>
                              | undefined)
                          : undefined;
                        const overrideValue = overrideRecord?.[key as string];
                        return (
                          <li
                            key={`${entry.hostId}:${entry.projectId}`}
                            className="flex items-center justify-between gap-3 px-2 py-1"
                          >
                            <button
                              type="button"
                              className="cursor-pointer truncate text-left text-foreground hover:underline"
                              onClick={entry.open}
                            >
                              {entry.label}
                            </button>
                            {scoped ? (
                              <span className="max-w-32 truncate text-muted-foreground tabular-nums">
                                {formatValue(key, overrideValue)}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
