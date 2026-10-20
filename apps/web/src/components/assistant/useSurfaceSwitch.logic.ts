// Pure part of surface switching: which thread a surface opens on. Kept free of React so the filters are unit-tested.
import { projectSurface, type AppSurface } from "../../chatSurface";

interface SwitchProject {
  readonly hostId: string;
  readonly id: string;
  readonly surface?: string | undefined;
}
interface SwitchThread {
  readonly hostId: string;
  readonly id: string;
  readonly projectId: string;
  readonly updatedAt: string;
  readonly archivedAt?: string | null | undefined;
}

/**
 * The most recently updated, un-archived thread that lives on `surface`, or null. A project belongs to exactly one
 * surface (`projectSurface`), so Kora never lands in a Code thread and vice versa. `excludeProjectIds`
 * hides retired blobs (their project stays, the roster hides them).
 */
export function latestThreadForSurface<T extends SwitchThread>(
  projects: readonly SwitchProject[],
  threads: readonly T[],
  surface: AppSurface,
  excludeProjectIds: ReadonlySet<string> = new Set(),
): T | null {
  const projectKeys = new Set(
    projects
      .filter((p) => projectSurface(p) === surface && !excludeProjectIds.has(p.id))
      .map((p) => `${p.hostId}:${p.id}`),
  );
  let best: T | null = null;
  for (const t of threads) {
    if (t.archivedAt || !projectKeys.has(`${t.hostId}:${t.projectId}`)) continue;
    if (!best || t.updatedAt > best.updatedAt) best = t;
  }
  return best;
}
