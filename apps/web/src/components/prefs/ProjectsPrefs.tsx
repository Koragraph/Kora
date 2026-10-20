/** `/Users/me/code/app` → `~/code/app`, so the folder reads before the path runs out. */

import { usePrefsProjectGroups } from "./usePrefsProjectGroups";
import { PrefsPageContainer, PrefsSection } from "./prefsLayout";
import { ProjectPrefsPanel } from "./ProjectPrefsPanel";
import { usePrefsScope } from "./PrefsScopeContext";
import { TrustedFoldersSection } from "../trust/TrustedFoldersSection";
import { ProjectFavicon } from "../ProjectIcon";
import { HostId } from "@kora/contracts";
import { ChevronRightIcon } from "lucide-react";

function homeRelativePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** Project identity and checkout management for the selected project. */
export function ProjectsPrefs() {
  const { search: value, scope } = usePrefsScope();
  // The panel follows remembered members when grouping replaces a project key.
  const remembersMembers =
    scope.kind === "unavailable" &&
    (scope.reason === "checkout-missing" || scope.reason === "project-missing");
  const projectScope = scope.kind === "checkout" || scope.kind === "project" || remembersMembers;
  const projectPrefsPanelBlock =
    value.project && projectScope ? (
      <ProjectPrefsPanel
        projectKey={value.project}
        hostId={value.machine ? HostId.make(value.machine) : null}
        checkoutKey={value.checkout ?? null}
      />
    ) : scope.kind === "unavailable" ? (
      <p className="p-8 text-sm text-muted-foreground">{scope.message}</p>
    ) : (
      <ProjectDirectory />
    );

  return <div className="flex min-h-0 flex-1 flex-col">{projectPrefsPanelBlock}</div>;
}

/** The projects Kora knows, one row each: open one to rename it, change its icon, set its actions. */
function ProjectDirectory() {
  const { selectScope } = usePrefsScope();
  const groups = usePrefsProjectGroups();
  return (
    <PrefsPageContainer>
      <PrefsSection title={`Projects · ${groups.length}`} variant="plain">
        {groups.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No projects yet. Add a folder from the sidebar to start one.
          </p>
        ) : (
          <p className="pb-2 text-sm text-muted-foreground">
            Open a project to rename it, change its icon or set its actions.
          </p>
        )}
        {groups.length === 0 ? null : (
          <ul
            aria-label="Projects"
            className="divide-y divide-border/50 overflow-hidden rounded-lg bg-card ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5"
          >
            {groups.map((group) => {
              const root = group.memberProjects[0]?.workspaceRoot ?? group.workspaceRoot ?? "";
              const extra = group.memberProjects.length - 1;
              return (
                <li key={group.projectKey}>
                  <button
                    type="button"
                    data-project-row={group.displayName}
                    onClick={() => selectScope({ project: group.projectKey })}
                    className="group flex w-full min-w-0 cursor-pointer items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50"
                  >
                    <ProjectFavicon project={group} className="size-5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {group.displayName}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {homeRelativePath(root)}
                        {extra > 0
                          ? ` + ${extra} more ${extra === 1 ? "checkout" : "checkouts"}`
                          : ""}
                      </span>
                    </span>
                    <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PrefsSection>
      <TrustedFoldersSection />
    </PrefsPageContainer>
  );
}
