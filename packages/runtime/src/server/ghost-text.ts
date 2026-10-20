// Claude Code (and Codex) show a SUGGESTED next prompt in grey inside an empty input box ("> Save this as a research
// file"). As plain screen text it is indistinguishable from typed input: the lead read it as pending input / a steer and
// re-planned around words nobody typed. Only the cell attributes tell them apart — ghost text is dim (SGR 2) or a grey
// foreground — so the screen text the lead and kora's own checks read drops those cells on the prompt line.
import type { Cell } from '../protocol/types';

const ATTR_INVERSE = 8;
const ATTR_DIM = 16;

/** The input line of an agent TUI: `>` / `❯` / `›` at the start, bare or inside a `│ … │` box. */
export const PROMPT_LINE = /^\s*(?:│\s*)?[>❯›](?:\s|$)/;

/** A grey foreground: palette 8 (bright black), the 256-colour grey ramp, or an RGB grey of mid brightness. */
export function isGreyFg(fg: number): boolean {
  if (fg < 0) return false;
  if (fg & 0x1000000) {
    const r = (fg >> 16) & 0xff, g = (fg >> 8) & 0xff, b = fg & 0xff;
    return Math.max(r, g, b) - Math.min(r, g, b) <= 16 && r >= 64 && r <= 176;
  }
  return fg === 8 || (fg >= 237 && fg <= 249);
}

export function isGhostCell(c: Cell): boolean { return (c.attrs & ATTR_DIM) !== 0 || isGreyFg(c.fg); }

/**
 * A row of cells as text with the ghost suggestion removed, or null when it is not a prompt line (left as it was).
 * Only cells after the prompt marker count; the TUI's own drawn cursor (an inverse cell) sitting on the first ghost
 * char goes with it. Pure.
 */
export function promptLineWithoutGhost(row: Cell[]): string | null {
  const plain = row.map((c) => c.ch).join('');
  const m = PROMPT_LINE.exec(plain);
  if (!m) return null;
  const start = m[0].length;
  let changed = false;
  const out = row.map((c, i) => {
    if (i < start) return c.ch;
    const ghost = isGhostCell(c) || ((c.attrs & ATTR_INVERSE) !== 0 && c.ch.trim() !== '' && i + 1 < row.length && isGhostCell(row[i + 1]));
    if (ghost && c.ch.trim() !== '') { changed = true; return ' '; }
    return c.ch;
  });
  return changed ? out.join('').trimEnd() : null;
}
