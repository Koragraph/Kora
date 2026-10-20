import type { DraftId } from "~/stores/promptDraftStore";
import {
  MenuGroupLabel,
  MenuRadioGroup,
  MenuItem,
  MenuSeparator,
  MenuRadioItem,
  MenuTrigger,
  MenuPopup,
  MenuGroup,
  Menu,
} from "../ui/menu";
import { sortScopedProjectsForNav } from "../NavRows.logic";
import { cn } from "../../util/utils";
import { useRetargetDraftProject } from "../../hooks/useStartThread";
import { useAddLocalFolderProject } from "../../hooks/useAddLocalFolderProject";
import { isAssistantSurfaceProject } from "../../chatSurface";
import { useThreadSummaries, useProjects } from "../../atoms/entities";
import type { HostProject } from "@kora/client-runtime/store/models";
import { hostProjectRef } from "@kora/client-runtime/host";
// The directory a new Code thread will run in, shown under the hero greeting until the first
// message is sent (Claude Code style). Click to move the draft to another repository — the typed
// prompt stays — or to add a folder.
import { useMemo } from "react";
import { ChevronDownIcon, FolderPlusIcon, FolderIcon } from "lucide-react";

const projectKey = (p: Pick<HostProject, "hostId" | "id">) => `${p.hostId}:${p.id}`;

/** `/Users/me/src/app` → `~/src/app`: the home prefix is the noise, the tail is the signal. */
export function abbreviateHomePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

export function DraftProjectChip(props: { draftId: DraftId; project: HostProject }) {
  const { draftId, project } = props;
  const projects = useProjects();
  const threads = useThreadSummaries();
  const retarget = useRetargetDraftProject();
  const addLocalFolderProject = useAddLocalFolderProject();

  const codeProjects = useMemo(
    () =>
      sortScopedProjectsForNav(
        projects.filter((p) => !isAssistantSurfaceProject(p)),
        threads,
        "updated_at",
      ),
    [projects, threads],
  );
  const path = project.workspaceRoot ? abbreviateHomePath(project.workspaceRoot) : project.title;

  const menuRadioGroupPart = (
    <MenuRadioGroup
      value={projectKey(project)}
      onValueChange={(value) => {
        const next = codeProjects.find((p) => projectKey(p) === value);
        if (next) retarget(draftId, hostProjectRef(next.hostId, next.id));
      }}
    >
      {codeProjects.map((p) => (
        <MenuRadioItem key={projectKey(p)} value={projectKey(p)} closeOnClick>
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{p.title}</span>
            {p.workspaceRoot ? (
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {abbreviateHomePath(p.workspaceRoot)}
              </span>
            ) : null}
          </span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );

  return (
    <div className="mt-3 flex justify-center">
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              data-testid="draft-project-chip"
              aria-label={`Working directory: ${path}. Change`}
              className={cn(
                "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full px-2.5",
                "text-muted-foreground text-xs transition-colors",
                "hover:bg-accent hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground",
              )}
            />
          }
        >
          <FolderIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate font-mono">{path}</span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-70" aria-hidden />
        </MenuTrigger>
        <MenuPopup align="center" side="bottom" className="w-80">
          <MenuGroup>
            <MenuGroupLabel>Start this chat in</MenuGroupLabel>
            {menuRadioGroupPart}
          </MenuGroup>
          <MenuSeparator />
          <MenuItem onClick={() => void addLocalFolderProject()}>
            <FolderPlusIcon />
            Add a folder…
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
