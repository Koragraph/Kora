import { createJSONStorage, persist } from "zustand/middleware";
import { create } from "zustand";
import type { HostThreadRef } from "@kora/contracts";
import { hostThreadKey } from "@kora/client-runtime/host";

import { resolveStorage } from "../util/storage";

export type DockKind = "files" | "file" | "preview" | "terminal" | "fleet";

export type DockSurface =
  | { id: `browser:${string}`; kind: "preview"; resourceId: string }
  | { id: "browser:new"; kind: "preview"; resourceId: null }
  | {
      splitDirection?: "horizontal" | "vertical";
      activeTerminalId: string;
      terminalIds: string[];
      resourceId: string;
      kind: "terminal";
      id: `terminal:${string}`;
    }
  | { id: "files"; kind: "files" }
  | {
      revealRequestId: number;
      revealLine: number | null;
      relativePath: string;
      kind: "file";
      id: `file:${string}`;
    }
  | { id: "fleet"; kind: "fleet" };

export interface ThreadDockState {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: DockSurface[];
}

type TerminalSurface = Extract<DockSurface, { kind: "terminal" }>;
type FileSurface = Extract<DockSurface, { kind: "file" }>;

const NEW_BROWSER_ID = "browser:new";
const EMPTY_DOCK: ThreadDockState = Object.freeze({
  isOpen: false,
  activeSurfaceId: null,
  surfaces: Object.freeze([]) as unknown as DockSurface[],
}) as ThreadDockState;

const RETIRED_KINDS = new Set(["plan", "pull-request", "device", "diff", "agents"]);

// ---------- helpers ----------

const isBrowser = (surface: DockSurface) => surface.kind === "preview";

function revealLineOf(ln: unknown): number | null {
  return typeof ln === "number" && Number.isFinite(ln) ? Math.max(1, Math.trunc(ln)) : null;
}

/** Index to activate after removing the surface at `removedIndex` from `remaining`. */
function neighbour(leftover: DockSurface[], removedIndex: number): string | null {
  if (leftover.length === 0) return null;
  return leftover[Math.min(removedIndex, leftover.length - 1)]!.id;
}

function upsertActive(dockState: ThreadDockState, surface: DockSurface): ThreadDockState {
  const pos = dockState.surfaces.findIndex((entry) => entry.id === surface.id);
  const surfaces =
    pos < 0
      ? [...dockState.surfaces, surface]
      : dockState.surfaces.map((entry, idx) => (idx === pos ? surface : entry));
  return { isOpen: true, activeSurfaceId: surface.id, surfaces };
}

function terminalSurface(termKey: string): TerminalSurface {
  return {
    id: `terminal:${termKey}`,
    kind: "terminal",
    resourceId: termKey,
    terminalIds: [termKey],
    activeTerminalId: termKey,
  };
}

function mapTerminal(
  dockState: ThreadDockState,
  surfaceKey: string,
  update: (surface: TerminalSurface) => TerminalSurface,
): ThreadDockState {
  return {
    ...dockState,
    surfaces: dockState.surfaces.map((entry) =>
      entry.id === surfaceKey && entry.kind === "terminal" ? update(entry) : entry,
    ),
  };
}

// ---------- persisted-state migration ----------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function migrateSurface(unparsed: unknown): DockSurface | null {
  if (!isRecord(unparsed) || typeof unparsed.id !== "string" || typeof unparsed.kind !== "string")
    return null;
  if (RETIRED_KINDS.has(unparsed.kind)) return null;

  if (unparsed.kind === "file") {
    if (!unparsed.id.startsWith("file:")) return null;
    const req = unparsed.revealRequestId;
    return {
      ...(unparsed as unknown as FileSurface),
      revealLine: revealLineOf(unparsed.revealLine),
      revealRequestId: typeof req === "number" && Number.isSafeInteger(req) && req >= 0 ? req : 0,
    };
  }

  if (unparsed.kind === "terminal") {
    if (
      typeof unparsed.resourceId !== "string" ||
      unparsed.id !== `terminal:${unparsed.resourceId}`
    )
      return null;
    const listed = Array.isArray(unparsed.terminalIds)
      ? [...new Set(unparsed.terminalIds.filter((tt): tt is string => typeof tt === "string"))]
      : [];
    const terminalIds = listed.length > 0 ? listed : [unparsed.resourceId];
    const engaged =
      typeof unparsed.activeTerminalId === "string" &&
      terminalIds.includes(unparsed.activeTerminalId)
        ? unparsed.activeTerminalId
        : terminalIds[0]!;
    return { ...(unparsed as unknown as TerminalSurface), terminalIds, activeTerminalId: engaged };
  }

  return unparsed as unknown as DockSurface;
}

export function migratePersistedDockState(persisted: unknown): {
  byThreadKey: Record<string, ThreadDockState>;
} {
  const origin =
    isRecord(persisted) && isRecord(persisted.byThreadKey) ? persisted.byThreadKey : {};
  const byThreadKey: Record<string, ThreadDockState> = {};
  for (const [key, value] of Object.entries(origin)) {
    if (!isRecord(value)) continue;
    const surfaces = (Array.isArray(value.surfaces) ? value.surfaces : [])
      .map(migrateSurface)
      .filter((surface): surface is DockSurface => surface !== null);
    let engaged =
      typeof value.activeSurfaceId === "string" &&
      surfaces.some((surface) => surface.id === value.activeSurfaceId)
        ? value.activeSurfaceId
        : null;
    const openFlag =
      surfaces.length > 0 && (typeof value.isOpen === "boolean" ? value.isOpen : engaged !== null);
    if (openFlag && engaged === null) engaged = surfaces[0]!.id;
    // A closed panel only remembers its active tab when that was stored explicitly.
    if (!openFlag && typeof value.isOpen !== "boolean") engaged = null;
    byThreadKey[key] = { isOpen: openFlag, activeSurfaceId: engaged, surfaces };
  }
  return { byThreadKey };
}

// ---------- store ----------

interface DockStoreState {
  byThreadKey: Record<string, ThreadDockState>;
  userActionRevisionByThreadKey: Record<string, number>;
  getUserActionRevision: (handle: HostThreadRef) => number;
  open: (handle: HostThreadRef, variant: Exclude<DockKind, "file" | "terminal">) => void;
  openBrowser: (handle: HostThreadRef, tabKey: string | null) => void;
  openFile: (handle: HostThreadRef, relativePath: string, ln?: number) => void;
  openTerminal: (handle: HostThreadRef, termKey: string) => void;
  splitTerminal: (
    handle: HostThreadRef,
    surfaceKey: string,
    termKey: string,
    dir?: "horizontal" | "vertical",
  ) => void;
  activateTerminal: (handle: HostThreadRef, surfaceKey: string, termKey: string) => void;
  closeTerminal: (handle: HostThreadRef, surfaceKey: string, termKey: string) => void;
  activateSurface: (handle: HostThreadRef, surfaceKey: string) => void;
  closeSurface: (handle: HostThreadRef, surfaceKey: string) => void;
  reconcileBrowserSurfaces: (handle: HostThreadRef, tabIds: readonly string[]) => void;
  reconcileFileSurfaces: (handle: HostThreadRef, workspaceAvailable: boolean) => void;
  close: (handle: HostThreadRef) => void;
}

type Persisted = Pick<DockStoreState, "byThreadKey">;

export const useDockStore = create<DockStoreState>()(
  persist(
    (bag, get) => {
      /** Applies `change` to one thread's dock; `user` bumps the user-action counter. */
      const edit = (
        handle: HostThreadRef,
        user: boolean,
        change: (dockState: ThreadDockState) => ThreadDockState,
      ) =>
        bag((data) => {
          const keyName = hostThreadKey(handle);
          const live = data.byThreadKey[keyName] ?? EMPTY_DOCK;
          const upcoming = change(live);
          if (upcoming === live) return data;
          const byThreadKey = { ...data.byThreadKey };
          if (
            !upcoming.isOpen &&
            upcoming.activeSurfaceId === null &&
            upcoming.surfaces.length === 0
          ) {
            delete byThreadKey[keyName];
          } else {
            byThreadKey[keyName] = upcoming;
          }
          if (!user) return { byThreadKey };
          return {
            byThreadKey,
            userActionRevisionByThreadKey: {
              ...data.userActionRevisionByThreadKey,
              [keyName]: (data.userActionRevisionByThreadKey[keyName] ?? 0) + 1,
            },
          };
        });

      return {
        byThreadKey: {},
        userActionRevisionByThreadKey: {},
        getUserActionRevision: (handle) =>
          get().userActionRevisionByThreadKey[hostThreadKey(handle)] ?? 0,

        open: (handle, variant) =>
          edit(handle, true, (dockState) => {
            if (variant === "preview") {
              const earlierFound = dockState.surfaces.find(isBrowser);
              return earlierFound
                ? upsertActive(dockState, earlierFound)
                : upsertActive(dockState, {
                    id: NEW_BROWSER_ID,
                    kind: "preview",
                    resourceId: null,
                  });
            }
            return upsertActive(
              dockState,
              variant === "files" ? { id: "files", kind: "files" } : { id: "fleet", kind: "fleet" },
            );
          }),

        openBrowser: (handle, tabKey) =>
          edit(handle, true, (dockState) => {
            if (tabKey === null) {
              return upsertActive(dockState, {
                id: NEW_BROWSER_ID,
                kind: "preview",
                resourceId: null,
              });
            }
            const withoutPlaceholder = {
              ...dockState,
              surfaces: dockState.surfaces.filter((entry) => entry.id !== NEW_BROWSER_ID),
            };
            return upsertActive(withoutPlaceholder, {
              id: `browser:${tabKey}`,
              kind: "preview",
              resourceId: tabKey,
            });
          }),

        openFile: (handle, relativePath, ln) =>
          edit(handle, true, (dockState) => {
            const surfaceId = `file:${relativePath}` as const;
            const prior = dockState.surfaces.find(
              (entry): entry is FileSurface => entry.id === surfaceId,
            );
            const fallbackBase = {
              ...dockState,
              surfaces: dockState.surfaces.filter((entry) => entry.id !== "files"),
            };
            return upsertActive(fallbackBase, {
              id: surfaceId,
              kind: "file",
              relativePath,
              revealLine: revealLineOf(ln),
              revealRequestId: (prior?.revealRequestId ?? 0) + 1,
            });
          }),

        openTerminal: (handle, termKey) =>
          edit(handle, true, (dockState) => upsertActive(dockState, terminalSurface(termKey))),

        splitTerminal: (handle, surfaceKey, termKey, dir = "horizontal") =>
          edit(handle, true, (dockState) => {
            const dest = dockState.surfaces.find(
              (entry) => entry.id === surfaceKey && entry.kind === "terminal",
            );
            if (!dest) return dockState;
            const upcoming = mapTerminal(dockState, surfaceKey, (terminal) => {
              const { splitDirection: _old, ...rest } = terminal;
              return {
                ...rest,
                terminalIds: terminal.terminalIds.includes(termKey)
                  ? terminal.terminalIds
                  : [...terminal.terminalIds, termKey],
                activeTerminalId: termKey,
                ...(dir === "vertical" ? { splitDirection: "vertical" as const } : {}),
              };
            });
            return { ...upcoming, isOpen: true, activeSurfaceId: surfaceKey };
          }),

        activateTerminal: (handle, surfaceKey, termKey) =>
          edit(handle, true, (dockState) => {
            if (!dockState.surfaces.some((entry) => entry.id === surfaceKey)) return dockState;
            const upcoming = mapTerminal(dockState, surfaceKey, (terminal) =>
              terminal.terminalIds.includes(termKey)
                ? { ...terminal, activeTerminalId: termKey }
                : terminal,
            );
            return { ...upcoming, isOpen: true, activeSurfaceId: surfaceKey };
          }),

        closeTerminal: (handle, surfaceKey, termKey) =>
          edit(handle, true, (dockState) => {
            const pos = dockState.surfaces.findIndex(
              (entry) => entry.id === surfaceKey && entry.kind === "terminal",
            );
            if (pos < 0) return dockState;
            const surface = dockState.surfaces[pos] as TerminalSurface;
            const ids = surface.terminalIds.filter((tt) => tt !== termKey);
            if (ids.length === 0) {
              const surfaces = dockState.surfaces.filter((_, idx) => idx !== pos);
              return {
                isOpen: dockState.isOpen && surfaces.length > 0,
                activeSurfaceId:
                  dockState.activeSurfaceId === surfaceKey
                    ? neighbour(surfaces, pos)
                    : dockState.activeSurfaceId,
                surfaces,
              };
            }
            return mapTerminal(dockState, surfaceKey, (terminal) => ({
              ...terminal,
              terminalIds: ids,
              activeTerminalId:
                terminal.activeTerminalId === termKey
                  ? ids[ids.length - 1]!
                  : terminal.activeTerminalId,
            }));
          }),

        activateSurface: (handle, surfaceKey) =>
          edit(handle, true, (dockState) =>
            dockState.surfaces.some((entry) => entry.id === surfaceKey)
              ? { ...dockState, isOpen: true, activeSurfaceId: surfaceKey }
              : dockState,
          ),

        closeSurface: (handle, surfaceKey) =>
          edit(handle, true, (dockState) => {
            const pos = dockState.surfaces.findIndex((entry) => entry.id === surfaceKey);
            if (pos < 0) return dockState;
            const surfaces = dockState.surfaces.filter((_, idx) => idx !== pos);
            return {
              isOpen: dockState.isOpen && surfaces.length > 0,
              activeSurfaceId:
                dockState.activeSurfaceId === surfaceKey
                  ? neighbour(surfaces, pos)
                  : dockState.activeSurfaceId,
              surfaces,
            };
          }),

        reconcileBrowserSurfaces: (handle, tabIds) =>
          edit(handle, false, (dockState) => {
            const valid = new Set(tabIds);
            const others = dockState.surfaces.filter((entry) => !isBrowser(entry));
            const retained = dockState.surfaces.filter(
              (entry) =>
                isBrowser(entry) && entry.resourceId !== null && valid.has(entry.resourceId),
            );
            const have = new Set(
              retained.map((entry) => (entry as { resourceId: string }).resourceId),
            );
            const added: DockSurface[] = tabIds
              .filter((tt) => !have.has(tt))
              .map((tt) => ({
                id: `browser:${tt}` as const,
                kind: "preview" as const,
                resourceId: tt,
              }));
            const surfaces = [...others, ...retained, ...added];
            const activeSurvives = surfaces.some((entry) => entry.id === dockState.activeSurfaceId);
            const activeSurfaceId = activeSurvives
              ? dockState.activeSurfaceId
              : (surfaces.find(isBrowser)?.id ?? surfaces[0]?.id ?? null);
            const sameIds =
              surfaces.length === dockState.surfaces.length &&
              surfaces.every(
                (entry, idx) =>
                  entry === dockState.surfaces[idx] || entry.id === dockState.surfaces[idx]!.id,
              );
            if (sameIds && activeSurfaceId === dockState.activeSurfaceId) return dockState;
            return { ...dockState, surfaces, activeSurfaceId };
          }),

        reconcileFileSurfaces: (handle, workspaceAvailable) =>
          edit(handle, false, (dockState) => {
            if (workspaceAvailable) return dockState;
            const surfaces = dockState.surfaces.filter(
              (entry) => entry.kind !== "files" && entry.kind !== "file",
            );
            if (surfaces.length === dockState.surfaces.length) return dockState;
            const activeSurvives = surfaces.some((entry) => entry.id === dockState.activeSurfaceId);
            return {
              isOpen: dockState.isOpen && surfaces.length > 0,
              activeSurfaceId: activeSurvives
                ? dockState.activeSurfaceId
                : (surfaces[surfaces.length - 1]?.id ?? null),
              surfaces,
            };
          }),

        close: (handle) =>
          edit(handle, true, (dockState) =>
            dockState.isOpen ? { ...dockState, isOpen: false } : dockState,
          ),
      };
    },
    {
      name: "kora:dock-state:v2",
      version: 16,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state): Persisted => ({ byThreadKey: state.byThreadKey }),
      migrate: (persisted) => migratePersistedDockState(persisted),
    },
  ),
);

export function selectThreadDockState(
  byThreadKey: Record<string, ThreadDockState>,
  handle: HostThreadRef | null | undefined,
): ThreadDockState {
  return (handle ? byThreadKey[hostThreadKey(handle)] : undefined) ?? EMPTY_DOCK;
}

export function selectActiveDockSurface(
  byThreadKey: Record<string, ThreadDockState>,
  handle: HostThreadRef | null | undefined,
): DockSurface | null {
  const dockState = selectThreadDockState(byThreadKey, handle);
  if (!dockState.isOpen) return null;
  return dockState.surfaces.find((entry) => entry.id === dockState.activeSurfaceId) ?? null;
}
