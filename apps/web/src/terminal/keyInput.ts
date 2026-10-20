import { isMacPlatform } from "../util/utils";

/**
 * Line-editing shortcuts a Mac user expects in a shell (Option+Arrow = word, Cmd+Arrow = line edge, Cmd+Backspace =
 * kill to line start) are sent as the readline control sequences for them. Elsewhere Ctrl/Alt+Arrow move by word.
 */
export interface ShellKeyLike {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly type?: string;
}

type Modifier = "alt" | "ctrl" | "meta";

const READLINE = {
  wordLeft: "\u001bb",
  wordRight: "\u001bf",
  lineStart: "\u0001",
  lineEnd: "\u0005",
  killToStart: "\u0015",
} as const;

/** The one modifier held (shift aside), or null when none or several are down. */
function soleModifier(event: ShellKeyLike): Modifier | null {
  const held: Modifier[] = [];
  if (event.altKey) held.push("alt");
  if (event.ctrlKey) held.push("ctrl");
  if (event.metaKey) held.push("meta");
  return held.length === 1 ? held[0]! : null;
}

const isKeyDown = (event: ShellKeyLike) => event.type === undefined || event.type === "keydown";

export function terminalNavigationInputData(
  event: ShellKeyLike,
  platform: string = navigator.platform,
): string | null {
  if (!isKeyDown(event) || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  const direction = key === "arrowleft" ? "left" : key === "arrowright" ? "right" : null;
  if (!direction) return null;
  const modifier = soleModifier(event);
  if (!modifier) return null;
  const word = direction === "left" ? READLINE.wordLeft : READLINE.wordRight;
  if (isMacPlatform(platform)) {
    if (modifier === "alt") return word;
    if (modifier === "meta") return direction === "left" ? READLINE.lineStart : READLINE.lineEnd;
    return null;
  }
  return modifier === "meta" ? null : word;
}

export function terminalDeleteInputData(
  event: ShellKeyLike,
  platform: string = navigator.platform,
): string | null {
  if (!isKeyDown(event) || event.shiftKey || !isMacPlatform(platform)) return null;
  if (event.key.toLowerCase() !== "backspace") return null;
  return soleModifier(event) === "meta" ? READLINE.killToStart : null;
}
