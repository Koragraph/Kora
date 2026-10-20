import { useCallback, useSyncExternalStore } from "react";

const BREAKPOINT_PX = {
  "4xl": 2000,
  "3xl": 1600,
  "2xl": 1536,
  xl: 1280,
  lg: 1024,
  md: 768,
  sm: 640,
} as const;

type Breakpoint = keyof typeof BREAKPOINT_PX;
type BreakpointQuery = Breakpoint | `max-${Breakpoint}` | `${Breakpoint}:max-${Breakpoint}`;

export type MediaQueryInput = {
  pointer?: "coarse" | "fine";
  max?: Breakpoint | number;
  min?: Breakpoint | number;
};

const px = (breakpoint: Breakpoint | number): number =>
  typeof breakpoint === "number" ? breakpoint : BREAKPOINT_PX[breakpoint];
const minClause = (breakpoint: Breakpoint | number) => `(min-width: ${px(breakpoint)}px)`;
// The upper bound is exclusive, so stop one pixel short of the breakpoint.
const maxClause = (breakpoint: Breakpoint | number) => `(max-width: ${px(breakpoint) - 1}px)`;

function fromObject(query: MediaQueryInput): string {
  const clauses: string[] = [];
  if (query.min !== undefined) clauses.push(minClause(query.min));
  if (query.max !== undefined) clauses.push(maxClause(query.max));
  if (query.pointer) clauses.push(`(pointer: ${query.pointer})`);
  return clauses.length > 0 ? clauses.join(" and ") : "(min-width: 0px)";
}

function fromString(unparsed: string): string {
  if (unparsed.startsWith("(")) return unparsed;
  const clauses: string[] = [];
  for (const fragment of unparsed.split(":")) {
    if (fragment.startsWith("max-")) {
      const bp = fragment.slice(4);
      if (bp in BREAKPOINT_PX) clauses.push(maxClause(bp as Breakpoint));
    } else if (fragment in BREAKPOINT_PX) {
      clauses.push(minClause(fragment as Breakpoint));
    }
  }
  return clauses.length > 0 ? clauses.join(" and ") : unparsed;
}

export function useMediaQuery(needle: BreakpointQuery | MediaQueryInput | (string & {})): boolean {
  const settled = typeof needle === "string" ? fromString(needle) : fromObject(needle);

  const subscribe = useCallback(
    (notify: () => void) => {
      const arr = window.matchMedia(settled);
      arr.addEventListener("change", notify);
      return () => arr.removeEventListener("change", notify);
    },
    [settled],
  );
  const read = useCallback(() => window.matchMedia(settled).matches, [settled]);

  return useSyncExternalStore(subscribe, read, () => false);
}
