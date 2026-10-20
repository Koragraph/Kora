import type { PtySummary } from "@kora/contracts";

/** Human-readable label for a terminal tab; matches mobile and web sidebars. */
export function ptyLabelFor(terminalId: string): string {
  const numericSuffix = /^term(?:inal)?-(\d+)$/i.exec(terminalId)?.[1];
  return numericSuffix ? "Shell " + numericSuffix : terminalId;
}

/** Prefer server summary label when present; otherwise fall back to `ptyLabelFor`. */
export function resolveTerminalSessionLabel(
  terminalId: string,
  summary: Pick<PtySummary, "label"> | null | undefined,
): string {
  return summary?.label?.trim() || ptyLabelFor(terminalId);
}

/**
 * Client-side terminal id allocator. Ids are ALWAYS chosen by the client and sent explicitly
 * on every `terminal.open` / `terminal.attach` call — the server never allocates.
 *
 * Returns the lowest unused `term-N` id (starting at `term-1`), skipping any ids already in
 * `existingTerminalIds`.
 */
export function nextTerminalId(taken: ReadonlyArray<string>): string {
  const label = (n: number) => `term-${n}`;
  const occupied = new Set(taken);
  // At most taken.length ids can be occupied, so one of the first length+1 is free.
  for (let n = 1; ; n += 1) {
    if (!occupied.has(label(n))) return label(n);
  }
}
