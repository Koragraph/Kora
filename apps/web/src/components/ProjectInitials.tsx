import { cn } from "~/util/utils";
import { projectIconColorClassName } from "../appearance/projectIconColors";
import type { ProjectBadgeColor } from "@kora/contracts";

const initialsSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const projectInitialsCls1 = "size-full overflow-hidden rounded-[25%] font-mono select-none";

export function ProjectInitials({
  text,
  color,
  className,
}: {
  readonly className?: string | undefined;
  readonly color: ProjectBadgeColor;
  readonly text: string;
}) {
  // Wrapped like the emoji and Lucide branches so the monogram sits where an
  // <img> favicon would. Menu items, buttons and the like pull every bare svg
  // in with [&_svg]:-mx-0.5 to trim the padding stroke icons carry, and this
  // tile has no such padding.
  return (
    <span
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
      aria-hidden="true"
    >
      <svg
        className={cn(projectInitialsCls1, projectIconColorClassName(color))}
        style={{
          backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)",
        }}
        viewBox="0 0 16 16"
      >
        <text
          textLength={Array.from(initialsSegmenter.segment(text)).length === 1 ? 6 : 12}
          textRendering="geometricPrecision"
          lengthAdjust="spacingAndGlyphs"
          className="font-mono"
          textAnchor="middle"
          fill="currentColor"
          fontWeight="700"
          fontSize="8.25"
          y="10.8"
          x="8"
        >
          {text}
        </text>
      </svg>
    </span>
  );
}
