import { useMemo } from "react";

import { useClientPrefs } from "../../hooks/usePrefs";
import { selectProjectGroupingPrefs } from "../../workspace/logicalProject";
import { buildNavProjectSnapshots } from "../../navProjectGrouping";
import { useHosts, usePrimaryHostId } from "../../atoms/hosts";
import { useProjects } from "../../atoms/entities";
import { isBlobsSurfaceProject } from "../../chatSurface";

/** Settings uses the same logical projects as the sidebar, sorted by display name. Blob homes are not Code projects. */
export function usePrefsProjectGroups() {
  const projects = useProjects();
  const settings = useClientPrefs(selectProjectGroupingPrefs);
  const primaryHostId = usePrimaryHostId();
  const { environments } = useHosts();
  return useMemo(() => {
    const labels = new Map(environments.map((entry) => [entry.hostId, entry.label]));
    return buildNavProjectSnapshots({
      projects: projects.filter((project) => !isBlobsSurfaceProject(project)),
      settings,
      primaryHostId,
      resolveHostLabel: (id) => labels.get(id) ?? null,
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [environments, primaryHostId, projects, settings]);
}
