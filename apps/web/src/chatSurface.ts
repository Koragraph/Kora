// The Kora | Code top-level surface split, client side. A project's `surface` (server-set) decides where it lives:
// "blobs" projects (one per blob, under ~/Blobs, Kora's own included) show on the Kora surface; everything else is Code.
// Both assistant-lane projects have no code graph and no worktrees (the Chat surface they replaced was folded into Kora).
export type AppSurface = "blobs" | "code";

type SurfaceCarrier = { surface?: string | undefined } | null | undefined;

/** The surface a project lives on. An absent / unknown value is Code (every project older than the Kora surface). */
export function projectSurface(project: SurfaceCarrier): AppSurface {
  return project?.surface === "blobs" ? "blobs" : "code";
}

export function isBlobsSurfaceProject(project: SurfaceCarrier): boolean {
  return projectSurface(project) === "blobs";
}

/** The assistant lane (output cards, no graph UI, no Chat|Orchestrator|Swarm toggle): today exactly the Kora surface. */
export function isAssistantSurfaceProject(project: SurfaceCarrier): boolean {
  return isBlobsSurfaceProject(project);
}

/** The projects the `/` landing may open a draft in: the active surface's own. The Code tab never lands in a blob. */
export function landingProjectsForSurface<P extends { surface?: string | undefined }>(
  projects: readonly P[],
  surface: AppSurface,
): P[] {
  return projects.filter((p) => projectSurface(p) === surface);
}

/**
 * Old Chat links: `/chat`, `/chat/...` (a chat project page, a chat thread under it). The Chat surface became Kora, so
 * these land on Kora's own route. (Thread links `/<host>/<thread>` keep working: the migration kept every thread id.)
 */
export function isLegacyChatPath(pathname: string): boolean {
  return /^\/chats?(\/|$)/.test(pathname);
}
