/**
 * Inline SVG glyphs for the composer graph chip, mirroring the source assets in
 * `src/assets/graph-chip/*.svg`. Inlined (rather than imported as URLs) so they inherit
 * `currentColor` — the chip tints the graph glyph by freshness (green/amber/blue/grey),
 * which an <img> could not do. Keep these in sync with the .svg files of record.
 */
/** Three connected nodes — the code graph. Filled nodes so it reads solid at chip size. */

import type { SVGProps } from "react";

export function GraphNodesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M7.4 7.2 12 16.6M7.4 7.2 16.8 8.6M12 16.6 16.8 8.6"
        strokeLinecap="round"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <circle cx="7.4" cy="7.2" r="2.7" fill="currentColor" />
      <circle cx="16.8" cy="8.6" r="2.7" fill="currentColor" />
      <circle cx="12" cy="16.6" r="2.7" fill="currentColor" />
    </svg>
  );
}

/** A branch forking off the trunk — worktree. Line-art. */
export function WorktreeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M7 8.5v7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path
        d="M17 10.2c0 2.9-2.2 4-5 4.2-2.2.2-4.4.6-5 1.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <circle cx="7" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="7" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="17" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}
