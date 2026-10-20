/**
 * Pure rules behind the Graph Explorer panel, kept out of the component so they can be tested
 * without a canvas or a daemon.
 */

export type GraphLoadStatus = "idle" | "loading" | "ready" | "not-indexed" | "error";

/**
 * `GET /api/graph` answers 404 when the workspace has no indexed graph (including an empty
 * one). Anything else that is not a success — a 5xx, a dropped connection (`null`) — is a
 * failure worth retrying, not a reason to tell the user to index a repo that may be indexed.
 */
export function classifyGraphFailure(httpStatus: number | null): "not-indexed" | "error" {
  return httpStatus === 404 ? "not-indexed" : "error";
}

export interface GraphStatsSummary {
  readonly shownNodes: number;
  readonly totalNodes: number;
  readonly shownEdges: number;
}

/** The one-line status under the panel title; also what screen readers hear when it changes. */
export function graphStatusLine(status: GraphLoadStatus, stats: GraphStatsSummary | null): string {
  switch (status) {
    case "ready":
      return stats === null
        ? "Code graph"
        : `${stats.shownNodes.toLocaleString()} of ${stats.totalNodes.toLocaleString()} declarations · ${stats.shownEdges.toLocaleString()} relationships`;
    case "loading":
      return "Loading graph…";
    case "not-indexed":
      return "This workspace isn’t indexed yet";
    case "error":
      return "Couldn’t load the graph";
    case "idle":
      return "Code graph";
  }
}

/** Keeps the hover card inside the canvas: flips to the pointer's left near the right edge. */
export function hoverCardPosition(
  pointer: { readonly sx: number; readonly sy: number },
  canvasWidth: number,
  cardWidth = 280,
): { left: number; top: number } {
  const gap = 12;
  const right = pointer.sx + gap;
  const left = right + cardWidth > canvasWidth ? pointer.sx - gap - cardWidth : right;
  return { left: Math.max(8, left), top: Math.max(8, pointer.sy + gap) };
}
