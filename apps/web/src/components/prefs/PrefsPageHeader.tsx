import { PREFS_SECTION_LABELS, type PrefsPath } from "./prefsSearch";
import {
  prefsScopeHostLabel,
  ALL_PROJECTS_VALUE,
  selectProjectAxis,
  projectAxisValue,
  ALL_HOSTS_VALUE,
  selectHostAxis,
  hostAxisValue,
} from "./prefsScopeAxis";
import { resolvePrefsScope, type PrefsScopeSearch, findProjectGroup } from "./prefsScope";
import {
  Menu,
  MenuRadioGroup,
  MenuGroupLabel,
  MenuRadioItem,
  MenuGroup,
  MenuTrigger,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuPopup,
} from "../ui/menu";
import { ProjectFavicon } from "../ProjectIcon";
import { HostMachineIcon } from "../HostMachineIcon";
import { cn } from "../../util/utils";
import type { NavProjectSnapshot } from "../../navProjectGrouping";
import type { HostPresentation } from "../../atoms/hosts";
import { resolveHostMachineKind } from "@kora/contracts";
import { ChevronDownIcon, LayersIcon } from "lucide-react";

export interface PrefsScopePickerProps {
  readonly value: PrefsScopeSearch;
  readonly groups: readonly NavProjectSnapshot[];
  readonly environments: readonly HostPresentation[];
  readonly onChange: (next: PrefsScopeSearch) => void;
}

function pageTitle(pathname: string): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/settings/diagnostics") return "Diagnostics";
  return PREFS_SECTION_LABELS[path as PrefsPath] ?? "Settings";
}

function ScopePicker({ value, groups, environments, onChange }: PrefsScopePickerProps) {
  const showHostAxis = environments.length > 1;
  if (!showHostAxis && groups.length === 0) return null;

  const resolved = resolvePrefsScope(value, groups, environments);
  const hostValue = hostAxisValue(value, resolved.kind === "checkout" ? resolved.hostId : null);
  const selectedHost = environments.find((environment) => environment.hostId === hostValue);
  const selectedProject = findProjectGroup(groups, value.project);
  const narrowed = (showHostAxis && hostValue !== ALL_HOSTS_VALUE) || selectedProject !== undefined;

  const hostLabel = selectedHost
    ? prefsScopeHostLabel(selectedHost, environments)
    : hostValue !== ALL_HOSTS_VALUE
      ? "Unavailable environment"
      : "every machine";

  const everyMachineItem = (
    <MenuRadioItem value={ALL_HOSTS_VALUE}>
      <span className="flex min-w-0 items-center gap-2">
        <LayersIcon className="size-3.5 shrink-0" />
        <span className="truncate">Every machine</span>
      </span>
      <MenuRadioItemIndicator />
    </MenuRadioItem>
  );
  const environmentItems = environments.map((environment) => (
    <MenuRadioItem value={environment.hostId} key={environment.hostId}>
      <span className="flex min-w-0 items-center gap-2">
        <HostMachineIcon
          kind={resolveHostMachineKind(environment.daemonConfig)}
          className="size-3.5 shrink-0"
        />
        <span className="truncate">{prefsScopeHostLabel(environment, environments)}</span>
        {environment.connection.phase === "connected" ? null : (
          <span className="text-xs text-muted-foreground">Offline</span>
        )}
      </span>
      <MenuRadioItemIndicator />
    </MenuRadioItem>
  ));

  const groupDivider = <MenuSeparator />;
  const menuGroupBlock = showHostAxis ? (
    <>
      <MenuGroup>
        <MenuGroupLabel>Environment</MenuGroupLabel>
        <MenuRadioGroup
          value={hostValue}
          onValueChange={(next) => {
            if (typeof next === "string") onChange(selectHostAxis(value, next));
          }}
        >
          {everyMachineItem}
          <MenuSeparator />
          {environmentItems}
        </MenuRadioGroup>
      </MenuGroup>
      {groupDivider}
    </>
  ) : null;

  const menuRadioItemPart = (
    <MenuRadioItem value={ALL_PROJECTS_VALUE}>
      <span className="truncate">Every project</span>
      <MenuRadioItemIndicator />
    </MenuRadioItem>
  );

  const menuRadioGroupKids = (
    <>
      {menuRadioItemPart}
      <MenuSeparator />
      {groups.map((group) => (
        <MenuRadioItem value={group.projectKey} key={group.projectKey}>
          <span className="flex min-w-0 items-center gap-2">
            <ProjectFavicon project={group} className="size-3.5 shrink-0" />
            <span className="truncate">{group.displayName}</span>
          </span>
          <MenuRadioItemIndicator />
        </MenuRadioItem>
      ))}
    </>
  );

  const menuRadioGroupPart = (
    <MenuRadioGroup
      onValueChange={(next) => {
        if (typeof next === "string") onChange(selectProjectAxis(value, next));
      }}
      value={projectAxisValue(value)}
    >
      {menuRadioGroupKids}
    </MenuRadioGroup>
  );

  return (
    <Menu>
      <MenuTrigger
        aria-label="Settings scope"
        className={cn(
          "ml-auto inline-flex h-7 max-w-72 min-w-0 shrink cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          narrowed
            ? "border-border/70 bg-[var(--settings-raised)] text-foreground"
            : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-[var(--settings-raised)] hover:text-foreground",
        )}
      >
        <span aria-hidden className="shrink-0 text-muted-foreground/70">
          For
        </span>
        {showHostAxis ? (
          <>
            {selectedHost ? (
              <HostMachineIcon
                kind={resolveHostMachineKind(selectedHost.daemonConfig)}
                className="size-3.5 shrink-0"
              />
            ) : (
              <LayersIcon className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{hostLabel}</span>
          </>
        ) : null}
        {selectedProject ? (
          <>
            {showHostAxis ? <span className="text-muted-foreground/60">›</span> : null}
            <ProjectFavicon project={selectedProject} className="size-3.5 shrink-0" />
            <span className="truncate">{selectedProject.displayName}</span>
          </>
        ) : showHostAxis ? null : (
          <span className="truncate">every project</span>
        )}
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/70" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-64 max-w-[calc(100vw-2rem)]">
        {menuGroupBlock}
        <MenuGroup>
          <MenuGroupLabel>Project</MenuGroupLabel>
          {menuRadioGroupPart}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

export function PrefsPageHeader(props: { pathname: string; scope?: PrefsScopePickerProps }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <h1 className="shrink-0 truncate text-[15px] font-semibold tracking-tight text-foreground">
        {pageTitle(props.pathname)}
      </h1>
      {props.scope ? <ScopePicker {...props.scope} /> : null}
    </div>
  );
}
