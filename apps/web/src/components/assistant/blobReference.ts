/**
 * "Reference this worker in the message" — shared by the drag-onto-composer gesture (SwarmBlob)
 * and the "Reference in message" menu item (blobMenu.ts). `FleetSwarmReportRef` (contracts
 * fleet.ts) carries only `bytes` / `updatedAt` / `preview` — no path — so there is nothing to
 * build a real file-link mention from; this always inserts the human-readable fallback form the
 * spec calls out (`@worker p3 (IMDb sitcoms)`), never a `ContextChipReference` file chip.
 */
import type { FleetWorker } from "@kora/contracts";

/** Text inserted into the composer to reference a worker. */
export function workerReferenceText(worker: FleetWorker): string {
  return `@worker ${worker.paneId} (${worker.title})`;
}

/** The HTML5 drag payload for "drag this blob onto the composer" (SwarmBlob.tsx onDragStart). */
export interface WorkerDragPayload {
  readonly type: string;
  readonly text: string;
}

/**
 * Reuses the composer's existing file-tree-drag mention channel (`PROMPT_MENTION_DRAG_TYPE`):
 * the composer already claims drops of this MIME type, shows the drop highlight, and inserts
 * whatever text is on it — dragging a worker blob needs no composer-side wiring at all.
 */
export function workerDragPayload(worker: FleetWorker, dragType: string): WorkerDragPayload {
  return { type: dragType, text: workerReferenceText(worker) };
}

/** Appends a worker reference to a prompt, skipping if that exact reference is already present. */
export function appendWorkerReference(prompt: string, worker: FleetWorker): string {
  const text = workerReferenceText(worker);
  if (prompt.includes(text)) return prompt;
  const trimmed = prompt.length > 0 && !/\s$/.test(prompt);
  return `${prompt}${trimmed ? " " : ""}${text} `;
}
