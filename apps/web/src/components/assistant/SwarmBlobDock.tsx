/**
 * The worker dock: every worker in the thread's fleet as a still pixel sprite on the right edge of the chat canvas,
 * wearing its agent's accessory (blobState.ts). Working workers stand on top, then the rest still in play; done,
 * failed and asleep ones fold into one small pile below (click it to lay them out). Under it, on the Code surface, a
 * grid icon shows every worker's pane at once (the Fleet panel).
 *
 * Clicking a sprite opens that worker's window (WorkerFloatingWindow, portaled to document.body — see that file for
 * why): traffic lights, the agent's logo, what it is doing, and its feed as a small chat. A second click on another
 * sprite switches the window's content without unmounting its chrome. Self-contained: reads its own fleet snapshot,
 * mounted by the chat canvas with just a thread ref.
 *
 * Also here: dragging a sprite onto the composer and its "Reference in message" menu twin (blobReference.ts), and the
 * right-click / "⋯" action menu (blobMenu.ts).
 */

import { usePromptDraftStore } from "~/stores/promptDraftStore";
import { readLocalApi } from "~/localApi";
import { threadToast, toastManager } from "~/components/ui/toast";
import { PROMPT_MENTION_DRAG_TYPE } from "~/components/thread/promptMentionDrag";
import { mergedPaneIds, useFleetSnapshot } from "~/components/FleetPanel";
import { useAtomAction } from "~/atoms/use-atom-command";
import { fleetHost } from "~/atoms/fleet";
import type { HostThreadRef, FleetWorker } from "@kora/contracts";
import {
  squashAtomActionFailure,
  isAtomActionInterrupted,
  type AtomActionResult,
} from "@kora/client-runtime/store/runtime";
import { useCallback, type DragEvent as ReactDragEvent, useEffect, useState, useMemo } from "react";
import { LayoutGridIcon } from "lucide-react";
import { PixelSprite } from "~/components/sprite";
import "./blobs.css";
import { SPRITE_STATE, dockGroups } from "./blobState";
import { appendWorkerReference, workerDragPayload } from "./blobReference";
import { extendMinutesForAction, buildBlobMenuItems, type BlobMenuActionId } from "./blobMenu";
import { WorkerFloatingWindow } from "./WorkerFloatingWindow";
import { SwarmBlob } from "./SwarmBlob";

/** More than this many live sprites and the stack scrolls with a "+N" instead of growing. */
const MAX_VISIBLE_BLOBS = 8;
/** Faces shown on the folded pile; the count says the rest. */
const PILE_FACES = 3;

/** Surface a failed command as an error toast, unless it was only interrupted. */
type FailedCommand = Extract<AtomActionResult<unknown, unknown>, { _tag: "Failure" }>;

function toastCommandFailure(result: FailedCommand, title: string): void {
  if (isAtomActionInterrupted(result)) {
    return;
  }
  const description = String(squashAtomActionFailure(result));
  toastManager.add(threadToast({ title, description, type: "error" }));
}

/** Gap reserved in the messages timeline's right padding so the dock never covers a bubble's
 *  right edge — matches the dock's own horizontal footprint (blob width + inset). */
export const SWARM_DOCK_GUTTER_PX = 64;

/** The transcript column's max width (ThreadTranscript's `max-w-3xl`), in rem. */
const TRANSCRIPT_COLUMN_REM = 48;

/**
 * Whether the centred transcript column would reach under the dock in a timeline `width` px wide.
 * Only then does the timeline give up its right gutter; a wide window keeps the chat centred.
 */
export function swarmDockOverlapsColumn(
  width: number,
  remPx = 16,
  gutterPx = SWARM_DOCK_GUTTER_PX,
): boolean {
  const column = Math.min(width, TRANSCRIPT_COLUMN_REM * remPx);
  return (width - column) / 2 < gutterPx;
}

/** The gutter the dock really needs: from its left edge to the timeline's right edge, never under the sprite-only
 *  default (an open pile or a wide accessory can make the stack wider than the bare sprites). */
export function swarmDockGutterFor(
  timeline: { readonly right: number },
  dock: { readonly left: number; readonly width: number },
): number {
  if (dock.width === 0) return SWARM_DOCK_GUTTER_PX;
  return Math.max(SWARM_DOCK_GUTTER_PX, Math.ceil(timeline.right - dock.left));
}

/** Whether the given thread currently has a live fleet, i.e. whether SwarmBlobDock will render
 *  anything for it. Exported so ThreadView can reserve a right gutter in the timeline before the
 *  dock itself mounts — avoids a layout jump when the first worker's blob pops in. */
export function useSwarmDockVisible(threadRef: HostThreadRef | null): boolean {
  const snapshot = useFleetSnapshot(threadRef);
  return (snapshot?.workers.length ?? 0) > 0;
}

export interface SwarmBlobDockProps {
  readonly threadRef: HostThreadRef;
  /** Bottom offset (px) to clear the composer overlay, which floats above this container. */
  readonly composerInsetPx?: number;
  /** Code surface only: the grid icon under the sprites that shows every worker's pane at once (the Fleet panel).
   *  Omitted on the assistant lane, which has no pane grid. */
  readonly onPaneMode?: () => void;
}

export function SwarmBlobDock({
  threadRef,
  composerInsetPx: promptInsetPx = 0,
  onPaneMode,
}: SwarmBlobDockProps) {
  const snapshot = useFleetSnapshot(threadRef);
  const workers = snapshot?.workers ?? [];
  const [openPaneId, setOpenPaneId] = useState<string | null>(null);

  const runKill = useAtomAction(fleetHost.kill, { reportFailure: true });
  const runSteer = useAtomAction(fleetHost.steer, { reportFailure: true });
  const runMerge = useAtomAction(fleetHost.merge, { reportFailure: true });
  const runRetry = useAtomAction(fleetHost.retry, { reportFailure: false });
  const runExtend = useAtomAction(fleetHost.extend, { reportFailure: false });

  const { live, resting } = useMemo(() => dockGroups(workers), [workers]);
  const visible = live.slice(0, MAX_VISIBLE_BLOBS);
  const overflow = live.length - visible.length;
  // The pile lays itself out on a click, and stays laid out while one of its workers' windows is open.
  const [pileOpen, setPileOpen] = useState(false);
  const showResting = pileOpen || resting.some((vm) => vm.paneId === openPaneId);
  const openWorker = openPaneId ? (workers.find((w) => w.paneId === openPaneId) ?? null) : null;
  const workerByPaneId = useMemo(
    () => new Map(workers.map((worker) => [worker.paneId, worker] as const)),
    [workers],
  );

  // The worker the open pane points at can exit or disappear from the snapshot; close cleanly.
  useEffect(() => {
    if (openPaneId && !workers.some((w) => w.paneId === openPaneId)) setOpenPaneId(null);
  }, [openPaneId, workers]);

  // Clicking the already-open blob closes the window instead of re-opening the same one — the
  // blob doubles as the window's other close control alongside the traffic lights.
  const openPane = useCallback(
    (paneId: string) => setOpenPaneId((current) => (current === paneId ? null : paneId)),
    [],
  );
  const closePane = useCallback(() => setOpenPaneId(null), []);

  const kill = useCallback(
    (paneId: string) => {
      void runKill({ hostId: threadRef.hostId, input: { threadId: threadRef.threadId, paneId } });
      setOpenPaneId((current) => (current === paneId ? null : current));
    },
    [runKill, threadRef.hostId, threadRef.threadId],
  );
  const steer = useCallback(
    (paneId: string, text: string) =>
      runSteer({
        hostId: threadRef.hostId,
        input: { threadId: threadRef.threadId, paneId, text, submit: true },
      }),
    [runSteer, threadRef.hostId, threadRef.threadId],
  );

  const referenceWorker = useCallback(
    (worker: FleetWorker) => {
      const store = usePromptDraftStore.getState();
      const current = store.getComposerDraft(threadRef)?.prompt ?? "";
      store.setPrompt(threadRef, appendWorkerReference(current, worker));
    },
    [threadRef],
  );

  const runMenuAction = useCallback(
    async (worker: FleetWorker, action: BlobMenuActionId) => {
      switch (action) {
        case "open-terminal":
          setOpenPaneId(worker.paneId);
          return;
        case "reference":
          referenceWorker(worker);
          return;
        case "retry": {
          const result = await runRetry({
            hostId: threadRef.hostId,
            input: { threadId: threadRef.threadId, paneId: worker.paneId },
          });
          if (result._tag === "Failure") {
            toastCommandFailure(result, "Couldn't retry on a different model");
            return;
          }
          toastManager.add({ type: "success", title: "Retrying on a different model" });
          return;
        }
        case "extend-5":
        case "extend-15":
        case "extend-30": {
          const minutes = extendMinutesForAction(action);
          if (minutes == null) return;
          const result = await runExtend({
            hostId: threadRef.hostId,
            input: { threadId: threadRef.threadId, paneId: worker.paneId, minutes },
          });
          if (result._tag === "Failure") {
            toastCommandFailure(result, "Couldn't give it more time");
            return;
          }
          toastManager.add({ type: "success", title: `Gave it ${minutes} more minutes` });
          return;
        }
        case "stop": {
          const confirmed = await readLocalApi()?.dialogs.confirm(
            `Stop worker "${worker.title}"?`,
            { variant: "destructive", confirmLabel: "Stop worker" },
          );
          if (!confirmed) return;
          kill(worker.paneId);
          return;
        }
        case "extend-menu":
          return;
      }
    },
    [kill, referenceWorker, runExtend, runRetry, threadRef.hostId, threadRef.threadId],
  );

  const openWorkerMenu = useCallback(
    (paneId: string, position: { x: number; y: number }) => {
      const worker = workerByPaneId.get(paneId);
      if (!worker) return;
      void (async () => {
        const api = readLocalApi();
        if (!api) {
          return;
        }
        const clicked = await api.contextMenu.show(buildBlobMenuItems(worker), position);
        if (clicked === null) return;
        await runMenuAction(worker, clicked);
      })();
    },
    [runMenuAction, workerByPaneId],
  );

  const onBlobDragStart = useCallback(
    (paneId: string, event: ReactDragEvent<HTMLButtonElement>) => {
      const worker = workerByPaneId.get(paneId);
      if (!worker) return;
      const payload = workerDragPayload(worker, PROMPT_MENTION_DRAG_TYPE);
      event.dataTransfer.setData(payload.type, payload.text);
      event.dataTransfer.effectAllowed = "move";
    },
    [workerByPaneId],
  );

  if (workers.length === 0) return null;

  // The dock itself never moves when a window opens or closes — that "ride along" shift (and an
  // unguarded terminal focus call while the old pane was still off-screen mid-animation) is what
  // used to shake the whole canvas; see WorkerFloatingWindow.tsx's module doc.
  const clearedBottom = promptInsetPx + 12;

  return (
    <>
      <div className="swarm-blob-dock" style={{ bottom: clearedBottom }}>
        <div className="swarm-blob-dock__stack">
          {visible.map((vm) => (
            <SwarmBlob
              key={vm.paneId}
              vm={vm}
              selected={vm.paneId === openPaneId}
              onOpen={openPane}
              onContextMenu={openWorkerMenu}
              onDragStart={onBlobDragStart}
            />
          ))}
          {overflow > 0 ? <div className="swarm-blob-dock__overflow">+{overflow}</div> : null}
          {resting.length > 0 && showResting ? (
            <div className="swarm-blob-dock__rested">
              {resting.map((vm) => (
                <SwarmBlob
                  key={vm.paneId}
                  vm={vm}
                  size={24}
                  selected={vm.paneId === openPaneId}
                  onOpen={openPane}
                  onContextMenu={openWorkerMenu}
                  onDragStart={onBlobDragStart}
                />
              ))}
              <button
                type="button"
                className="swarm-blob-dock__less"
                onClick={() => setPileOpen(false)}
              >
                less
              </button>
            </div>
          ) : resting.length > 0 ? (
            <button
              type="button"
              className="swarm-blob-dock__pile"
              aria-label={`${resting.length} finished ${resting.length === 1 ? "worker" : "workers"}`}
              onClick={() => setPileOpen(true)}
            >
              <span className="swarm-blob-dock__pile-faces" aria-hidden>
                {resting.slice(0, PILE_FACES).map((vm) => (
                  <PixelSprite
                    key={vm.paneId}
                    state={SPRITE_STATE[vm.state]}
                    accessory={vm.accessory}
                    size={12}
                    still
                  />
                ))}
              </span>
              <span className="swarm-blob-dock__pile-count">+{resting.length}</span>
              {resting.some((vm) => vm.state === "failed") ? (
                <span className="swarm-blob__dot" data-dot="fail" aria-hidden />
              ) : null}
            </button>
          ) : null}
          {onPaneMode ? (
            <button
              type="button"
              className="swarm-blob-dock__grid"
              onClick={onPaneMode}
              aria-label="Show all worker panes"
            >
              <LayoutGridIcon aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
      {openWorker ? (
        <WorkerFloatingWindow
          threadRef={threadRef}
          worker={openWorker}
          onClose={closePane}
          onKill={() => kill(openWorker.paneId)}
          onSteer={(text) => steer(openWorker.paneId, text)}
          onMerge={() =>
            runMerge({
              hostId: threadRef.hostId,
              input: { threadId: threadRef.threadId, paneId: openWorker.paneId },
            })
          }
          merged={mergedPaneIds(snapshot).has(openWorker.paneId)}
          onOpenMenu={(position) => openWorkerMenu(openWorker.paneId, position)}
        />
      ) : null}
    </>
  );
}
