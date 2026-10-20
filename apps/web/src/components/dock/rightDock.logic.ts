import type { DockSurface } from "~/stores/dockStore";

/**
 * The right dock groups panel surfaces by what they are for. Each group has one button on the dock
 * rail; a group can hold several surfaces (browser pages, open files, terminals) that the panel
 * header lists while that group is showing.
 */
export type DockGroup = "workers" | "files" | "browser" | "terminal";

/** Rail order: the fleet first (it is Kora's own surface), then the workspace tools. */
export const DOCK_GROUPS: readonly DockGroup[] = ["workers", "files", "browser", "terminal"];

export const DOCK_GROUP_LABELS: Record<DockGroup, string> = {
  workers: "Workers",
  files: "Files",
  browser: "Browser",
  terminal: "Terminal",
};

export function dockGroupOf(surface: DockSurface): DockGroup {
  switch (surface.kind) {
    case "fleet":
      return "workers";
    case "files":
    case "file":
      return "files";
    case "preview":
      return "browser";
    case "terminal":
      return "terminal";
  }
}

export function surfacesInGroup(surfaces: readonly DockSurface[], group: DockGroup): DockSurface[] {
  return surfaces.filter((surface) => dockGroupOf(surface) === group);
}

/**
 * What a click on a rail button does:
 * - `close` when that group is already showing (the button doubles as the panel's hide control),
 * - `activate` an existing surface of the group (the one shown last in it, else its last tab),
 * - `create` the group's first surface when it has none yet.
 */
export type DockSelection =
  | { readonly action: "close" }
  | { readonly action: "activate"; readonly surfaceId: string }
  | { readonly action: "create" };

export function resolveDockSelection(input: {
  readonly group: DockGroup;
  readonly panelOpen: boolean;
  readonly surfaces: readonly DockSurface[];
  readonly activeSurfaceId: string | null;
  /** Last surface shown per group in this thread, if the panel remembers one. */
  readonly lastSurfaceIdByGroup?: Readonly<Partial<Record<DockGroup, string>>>;
}): DockSelection {
  const active = input.surfaces.find((surface) => surface.id === input.activeSurfaceId) ?? null;
  if (input.panelOpen && active && dockGroupOf(active) === input.group) {
    return { action: "close" };
  }
  const members = surfacesInGroup(input.surfaces, input.group);
  if (members.length === 0) return { action: "create" };
  const remembered = input.lastSurfaceIdByGroup?.[input.group];
  const target =
    (active && dockGroupOf(active) === input.group ? active : null) ??
    members.find((surface) => surface.id === remembered) ??
    members.at(-1)!;
  return { action: "activate", surfaceId: target.id };
}
