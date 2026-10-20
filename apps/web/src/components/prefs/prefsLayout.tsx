import { useClearProjectOverrides, useClearScopedPrefs } from "./useScopedPrefs";
import {
  isProjectScopedSettingKey,
  listProjectOverrides,
  scopedPrefsAreMixed,
  scopedPrefsSource,
} from "./scopedPrefs";
import {
  type SettingOverridingProject,
  type SettingInheritanceState,
  SettingInheritance,
} from "./SettingInheritance";
import { useOptionalPrefsScope } from "./PrefsScopeContext";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { Button } from "../ui/button";
import { SurfacePageContainer, type WorkspacePageWidth } from "../SurfacePageContainer";
import { cn } from "../../util/utils";
import { DEFAULT_DAEMON_PREFS, type DaemonPrefs } from "@kora/contracts";
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  type ComponentPropsWithoutRef,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Undo2Icon, InfoIcon } from "lucide-react";
import * as Equal from "effect/Equal";
import { useLocation, useNavigate } from "@tanstack/react-router";

const PULSE_CLASS = "prefs-search-target-pulse";

declare module "@tanstack/react-router" {
  interface HistoryState {
    settingsTargetHighlight?: boolean | undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Jumping to a setting
// ---------------------------------------------------------------------------------------------------------------

function jumpToElement(element: HTMLElement, highlight: boolean): void {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const marked =
    typeof element.querySelector === "function"
      ? element.querySelector<HTMLElement>(":scope > [data-prefs-scroll-target]")
      : null;
  const scrollTarget =
    marked ??
    (element.tagName === "SECTION" ? (element.firstElementChild as HTMLElement | null) : null) ??
    element;
  scrollTarget.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  element.focus({ preventScroll: true });

  element.classList.remove(PULSE_CLASS);
  if (!highlight || reducedMotion) return;
  void element.offsetWidth; // restart the animation
  element.classList.add(PULSE_CLASS);
  element.addEventListener("blur", () => element.classList.remove(PULSE_CLASS), { once: true });
}

export function scrollToPrefsTarget(targetId: string, opts?: { highlight?: boolean }): boolean {
  const element = document.getElementById(targetId);
  if (!element) return false;
  jumpToElement(element, opts?.highlight ?? true);
  return true;
}

interface SearchTargetState {
  readonly targetId: string | null;
  readonly highlight: boolean;
  readonly onHandled: (() => void) | undefined;
}

const SearchTargetContext = createContext<SearchTargetState>({
  targetId: null,
  highlight: true,
  onHandled: undefined,
});

export function PrefsSearchTargetProvider(props: {
  onTargetHandled?: () => void;
  highlightTarget?: boolean;
  targetId: string | null;
  children: ReactNode;
}) {
  const value = useMemo<SearchTargetState>(
    () => ({
      targetId: props.targetId,
      highlight: props.highlightTarget ?? true,
      onHandled: props.onTargetHandled,
    }),
    [props.targetId, props.highlightTarget, props.onTargetHandled],
  );
  return <SearchTargetContext value={value}>{props.children}</SearchTargetContext>;
}

export function usePrefsSearchTargetId(): string | null {
  return useContext(SearchTargetContext).targetId;
}

export function usePrefsSearchTarget<T extends HTMLElement>(
  id: string | undefined,
): (node: T | null) => void {
  const { targetId, highlight, onHandled } = useContext(SearchTargetContext);
  return useCallback(
    (node: T | null) => {
      if (!node || id === undefined || id !== targetId) return;
      jumpToElement(node, highlight);
      onHandled?.();
    },
    [id, targetId, highlight, onHandled],
  );
}

export function PrefsSearchTarget({ id, ...props }: ComponentPropsWithoutRef<"div">) {
  const ref = usePrefsSearchTarget<HTMLDivElement>(id);
  return <div ref={ref} id={id} tabIndex={id ? -1 : undefined} {...props} />;
}

// ---------------------------------------------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------------------------------------------

export const PREFS_PICKER_TRIGGER_CLASSNAME =
  "h-8 min-h-8 max-w-none shrink-0 text-foreground/90 hover:text-foreground sm:h-7 sm:min-h-7";

export function PolicyTooltip({ children }: { children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <Button variant="ghost-muted" size="icon-micro" aria-label="Background policy details" />
        }
      >
        <InfoIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {children}
      </TooltipPopup>
    </Tooltip>
  );
}

export function useRelativeTimeTick(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function SettingResetButton(props: {
  onClick: () => void;
  disabled?: boolean;
  tooltip?: string;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-micro"
            aria-label={`Reset ${props.label} to default`}
            disabled={props.disabled}
            onClick={(event) => {
              event.stopPropagation();
              props.onClick();
            }}
          />
        }
      >
        <Undo2Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip ?? "Reset to default"}</TooltipPopup>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Page, section, row
// ---------------------------------------------------------------------------------------------------------------

export function PrefsPageContainer(props: {
  width?: WorkspacePageWidth;
  children: ReactNode;
  className?: string;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const hash = location.hash.replace(/^#/, "");
  const highlight = location.state.settingsTargetHighlight !== false;

  const clearHash = useCallback(() => {
    if (location.hash === "") return;
    void navigate({
      search: ((previous: unknown) => previous) as never,
      state: { settingsTargetHighlight: true } as never,
      hashScrollIntoView: false,
      to: location.pathname,
      resetScroll: false,
      replace: true,
      hash: "",
    });
  }, [location.hash, location.pathname, navigate]);

  return (
    <PrefsSearchTargetProvider
      targetId={hash === "" ? null : hash}
      highlightTarget={highlight}
      onTargetHandled={clearHash}
    >
      <div
        data-prefs-page-scroll
        className="scroll-fade-top min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]"
      >
        <SurfacePageContainer
          width={props.width ?? "readable"}
          className={cn("gap-8", props.className)}
        >
          {props.children}
        </SurfacePageContainer>
      </div>
    </PrefsSearchTargetProvider>
  );
}

export function PrefsSection({
  title,
  hideTitle = false,
  icon,
  headerAction,
  variant = "grouped",
  children,
  id,
  className,
  ...props
}: ComponentPropsWithoutRef<"section"> & {
  variant?: "grouped" | "plain";
  headerAction?: ReactNode;
  hideTitle?: boolean;
  children: ReactNode;
  icon?: ReactNode;
  title: string;
}) {
  const ref = usePrefsSearchTarget<HTMLElement>(id);
  const body = (
    <div
      {...(hideTitle ? { "data-prefs-scroll-target": "" } : {})}
      className={cn(
        "relative overflow-visible",
        variant === "grouped" ? "[&>*+*]:border-t [&>*+*]:border-border/60" : "flex flex-col gap-1",
      )}
    >
      {children}
    </div>
  );
  return (
    <section
      ref={ref}
      id={id}
      tabIndex={id ? -1 : undefined}
      className={cn("flex flex-col gap-1", className)}
      {...props}
    >
      {hideTitle ? (
        <h2 className="sr-only">{title}</h2>
      ) : (
        <div
          data-prefs-scroll-target=""
          className="flex min-h-7 items-center justify-between gap-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <h2 className="flex min-h-7 items-center gap-2 text-[13px] font-semibold tracking-tight text-foreground">
              {icon}
              {title}
            </h2>
            <div className="h-px flex-1 bg-border/50" />
          </div>
          <div className="flex min-h-7 min-w-7 items-center justify-end">{headerAction}</div>
        </div>
      )}
      {body}
    </section>
  );
}

export function PrefsRow({
  serverScoped = false,
  mixed: mixedProp,
  onResetOverride,
  settingKeys,
  resetAction,
  description,
  className,
  children,
  control,
  status,
  title,
  id,
  ...props
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  settingKeys?: readonly (keyof DaemonPrefs)[];
  onResetOverride?: () => void;
  resetAction?: ReactNode;
  description?: ReactNode;
  serverScoped?: boolean;
  children?: ReactNode;
  control?: ReactNode;
  status?: ReactNode;
  title: ReactNode;
  mixed?: boolean;
}) {
  const ref = usePrefsSearchTarget<HTMLDivElement>(id);
  const scope = useOptionalPrefsScope();
  const clearScoped = useClearScopedPrefs();
  const clearOverrides = useClearProjectOverrides();

  const keys = settingKeys ?? [];
  const scopedKeys = keys.filter((key) => isProjectScopedSettingKey(key as string)) as Parameters<
    typeof clearScoped
  >[0];
  const projectScope =
    scope !== null && (scope.scope.kind === "project" || scope.scope.kind === "checkout");
  const hostWide = projectScope && serverScoped && scopedKeys.length === 0;
  const unavailable = serverScoped && scope !== null && scope.connectedHosts.length === 0;
  const mixed =
    mixedProp ?? (scope !== null && keys.length > 0 && scopedPrefsAreMixed(scope.targets, keys));
  const source =
    projectScope && scope ? scopedPrefsSource(scope.targets, scopedKeys) : "environment";

  let reset: ReactNode = resetAction;
  if (unavailable) reset = null;
  else if (projectScope && scopedKeys.length > 0) {
    reset =
      source === "project" || source === "mixed" ? (
        <SettingResetButton
          onClick={onResetOverride ?? (() => clearScoped(scopedKeys))}
          label={typeof title === "string" ? title : "override"}
          tooltip="Reset to inherited value"
        />
      ) : null;
  }

  let indicator: ReactNode = null;
  if (scope && serverScoped && keys.length > 0) {
    let state: SettingInheritanceState;
    let summary: string;
    if (mixed) {
      state = "mixed";
      summary = "Mixed across selected environments";
    } else if (projectScope && source === "project") {
      state = "overridden";
      summary = "Overridden for this project";
    } else if (projectScope && scopedKeys.length > 0) {
      state = "inherited";
      const name = scope.scope.hostIds.length === 1 ? scope.targets[0]?.label : undefined;
      summary = `Inherited from ${name ?? "environment"}`;
    } else if (
      scope.targets.some((target) =>
        keys.some((key) => !Equal.equals(target.settings[key], DEFAULT_DAEMON_PREFS[key])),
      )
    ) {
      state = "environment";
      summary = "Set on the environment";
    } else {
      state = "default";
      summary = "Built-in default";
    }

    let overridingProjects: SettingOverridingProject[] = [];
    if (!projectScope && scopedKeys.length > 0) {
      overridingProjects = listProjectOverrides(scope.environments, scopedKeys).flatMap((entry) => {
        const group = scope.groups.find((candidate) =>
          candidate.memberProjects.some(
            (member) => member.hostId === entry.hostId && member.id === entry.projectId,
          ),
        );
        if (!group) return [];
        return [
          {
            ...entry,
            label: group.displayName,
            open: () =>
              scope.selectScope({
                project: group.projectKey,
                ...(scope.scope.kind === "environment" ? { machine: scope.scope.hostId } : {}),
              }),
          },
        ];
      });
    }

    indicator = (
      <SettingInheritance
        state={state}
        summary={summary}
        targets={scope.targets}
        environments={scope.connectedHosts}
        keys={keys}
        overridingProjects={overridingProjects}
        onClearOverrides={(entries) => clearOverrides(entries, scopedKeys)}
      />
    );
  }

  const blockedReason = unavailable
    ? "Reconnect to the Kora daemon to change this setting."
    : hostWide
      ? "Environment-wide setting. Select an environment to change it."
      : null;

  const controlNode =
    control === undefined || control === null ? null : blockedReason ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              className="rounded-md focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <span inert className="flex items-center gap-2 opacity-50">
            {control}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-72">
          {blockedReason}
        </TooltipPopup>
      </Tooltip>
    ) : (
      control
    );

  return (
    <div
      ref={ref}
      id={id}
      tabIndex={id ? -1 : undefined}
      data-slot="settings-row"
      className={cn(
        "-mx-3 rounded-lg px-3 pt-4 transition-colors hover:bg-[var(--settings-raised)] aria-disabled:opacity-50",
        children ? "pb-2" : "pb-4",
        className,
      )}
      {...props}
    >
      <div className="flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(160px,auto)] sm:items-center sm:gap-8">
        <div className="min-w-0 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-[13px] font-medium tracking-[-0.005em]">{title}</h3>
            {indicator}
            <span className="flex size-5 shrink-0 items-center justify-center">{reset}</span>
          </div>
          {description ? (
            <p className="max-w-xl text-[12.5px] leading-[1.5] text-muted-foreground">
              {description}
            </p>
          ) : null}
          {status ? <div className="pt-0.5 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {controlNode ? (
          <div className="flex w-full items-center gap-2 sm:w-auto sm:justify-end">
            {controlNode}
          </div>
        ) : null}
      </div>
      {children ? (
        unavailable ? (
          <div inert className="opacity-50">
            {children}
          </div>
        ) : (
          children
        )
      ) : null}
    </div>
  );
}
