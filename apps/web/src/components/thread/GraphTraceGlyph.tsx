import type { CSSProperties } from "react";

import { cn } from "~/util/utils";

// Four nodes on a short path, drawn left to right: a query hopping through the code graph.
const NODES = [
  { x: 2, y: 8.5 },
  { x: 7, y: 2.5 },
  { x: 12, y: 7.5 },
  { x: 17, y: 2 },
] as const;
const EDGE_POINTS = NODES.map((node) => `${node.x},${node.y}`).join(" ");

/**
 * The live-work mark. A signal runs along the edges and each node lights as it arrives. It
 * animates only while an ancestor has set `--visible-animation-state` (watchVisibleAnimation)
 * and holds still under reduced motion.
 */
export function GraphTraceGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 19 11"
      fill="none"
      className={cn("h-3 w-[1.1rem] shrink-0 overflow-visible", className)}
    >
      <polyline
        points={EDGE_POINTS}
        stroke="currentColor"
        strokeOpacity={0.22}
        strokeWidth={1}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        className="graph-glyph-edge"
        points={EDGE_POINTS}
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {NODES.map((node, index) => (
        <circle
          key={index}
          className="graph-glyph-node"
          cx={node.x}
          cy={node.y}
          r={1.6}
          fill="currentColor"
          style={{ "--graph-node-index": index } as CSSProperties}
        />
      ))}
    </svg>
  );
}
