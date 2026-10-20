// Is the Kora surface (blobs) on in this client? The build's switch (branding.ts KORA_SURFACE) or the daemon's answer
// on the blobs snapshot (`koraSurface`, set by the daemon's developer override). An older daemon that sends nothing,
// a snapshot still loading, or a disconnected daemon all read as coming soon.
import { useProjects } from "./atoms/entities";
import { KORA_SURFACE } from "./branding";
import { isBlobsSurfaceProject } from "./chatSurface";
import { useBlobsState } from "./components/blobs/shell/blobsApi";

export function isKoraSurfaceOn(
  build: "coming-soon" | "on",
  daemon: "coming-soon" | "on" | null | undefined,
): boolean {
  return build === "on" || daemon === "on";
}

export function useKoraSurfaceOn(): boolean {
  const { snapshot } = useBlobsState();
  return isKoraSurfaceOn(KORA_SURFACE, snapshot?.koraSurface);
}

/** True when this project is a blob's (Kora surface) and Kora is coming soon: its threads show the coming-soon page. */
export function useIsComingSoonKoraProject(
  hostId: string | null | undefined,
  projectId: string | null | undefined,
): boolean {
  const koraOn = useKoraSurfaceOn();
  const projects = useProjects();
  if (koraOn || !hostId || !projectId) return false;
  const project = projects.find((p) => p.hostId === hostId && p.id === projectId) ?? null;
  return isBlobsSurfaceProject(project);
}
