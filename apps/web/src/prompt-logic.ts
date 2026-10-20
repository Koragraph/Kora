import { serializeReplyFootnote, withReplyFootnoteComment } from "@kora/shared/assistantFootnotes";
import type { ReplyFootnote } from "@kora/contracts";

import { splitPromptIntoPromptSegments, type PromptSegment } from "./prompt-editor-mentions";

export type PromptTriggerKind = "path" | "slash-command" | "skill";
export type PromptSlashCommand = "model" | "plan" | "default";
export type PromptSubmissionIntent = "foreground" | "background";

export interface PromptTrigger {
  rangeEnd: number;
  rangeStart: number;
  query: string;
  kind: PromptTriggerKind;
}

export interface DismissedPromptTrigger {
  kind: PromptTriggerKind;
  rangeStart: number;
}

export function formatReplyFootnoteForPrompt(citation: ReplyFootnote, remark = ""): string {
  return `${serializeReplyFootnote(withReplyFootnoteComment(citation, remark))} `;
}

export function promptSubmissionIntentForEnter(args: {
  shiftKey: boolean;
}): PromptSubmissionIntent | null {
  return args.shiftKey ? null : "foreground";
}

// ---------- the collapsed editor model: every inline token is one character ----------

const isToken = (seg: PromptSegment) => seg.type !== "text";

function expandedLength(seg: PromptSegment): number {
  switch (seg.type) {
    case "text":
      return seg.text.length;
    case "skill":
      return seg.name.length + 1; // the leading "$"
    default:
      return seg.source.length;
  }
}

const collapsedLength = (seg: PromptSegment) =>
  isToken(seg) ? 1 : seg.type === "text" ? seg.text.length : 1;

function clampExpandedCursor(str: string, caret: number): number {
  if (!Number.isFinite(caret)) return str.length;
  return Math.max(0, Math.min(Math.floor(caret), str.length));
}

export function expandCollapsedPromptCursor(str: string, cursorInput: number): number {
  const pieces = splitPromptIntoPromptSegments(str);
  let leftover = clampExpandedCursor(str, cursorInput);
  if (pieces.length === 0) return leftover;

  let shift = 0;
  for (const seg of pieces) {
    const wd = expandedLength(seg);
    if (isToken(seg)) {
      if (leftover === 0) return shift;
      if (leftover <= 1) return shift + wd;
      leftover -= 1;
    } else {
      if (leftover <= wd) return shift + leftover;
      leftover -= wd;
    }
    shift += wd;
  }
  return shift;
}

export function clampCollapsedPromptCursor(str: string, cursorInput: number): number {
  const total = splitPromptIntoPromptSegments(str).reduce(
    (n, segment) => n + collapsedLength(segment),
    0,
  );
  if (!Number.isFinite(cursorInput)) return total;
  return Math.max(0, Math.min(Math.floor(cursorInput), total));
}

export function collapseExpandedPromptCursor(str: string, cursorInput: number): number {
  const pieces = splitPromptIntoPromptSegments(str);
  let leftover = clampExpandedCursor(str, cursorInput);
  if (pieces.length === 0) return leftover;

  let collapsed = 0;
  for (const seg of pieces) {
    const wd = expandedLength(seg);
    if (isToken(seg)) {
      if (leftover === 0) return collapsed;
      // A caret inside a token snaps to just after it.
      if (leftover <= wd) return collapsed + 1;
      leftover -= wd;
      collapsed += 1;
    } else {
      if (leftover <= wd) return collapsed + leftover;
      leftover -= wd;
      collapsed += wd;
    }
  }
  return collapsed;
}

export function isCollapsedCursorAdjacentToInlineToken(
  str: string,
  cursorInput: number,
  dir: "left" | "right",
): boolean {
  const pieces = splitPromptIntoPromptSegments(str);
  if (!pieces.some(isToken)) return false;
  const caret = clampCollapsedPromptCursor(str, cursorInput);
  let shift = 0;
  for (const seg of pieces) {
    if (isToken(seg) && caret === (dir === "left" ? shift + 1 : shift)) return true;
    shift += collapsedLength(seg);
  }
  return false;
}

// ---------- triggers ----------

/** The menu stays shut while the caret remains inside the trigger the user dismissed. */
export function isPromptTriggerDismissed(
  trigger: PromptTrigger | null,
  dismissed: DismissedPromptTrigger | null,
): boolean {
  return (
    trigger !== null &&
    dismissed !== null &&
    trigger.kind === dismissed.kind &&
    trigger.rangeStart === dismissed.rangeStart
  );
}

const isWhitespace = (ch: string) => ch === " " || ch === "\n" || ch === "\t" || ch === "\r";

export function detectPromptTrigger(str: string, cursorInput: number): PromptTrigger | null {
  const caret = clampExpandedCursor(str, cursorInput);
  const lineStart = caret === 0 ? 0 : str.lastIndexOf("\n", caret - 1) + 1;

  // Slash commands only exist at the very start of a line, before any whitespace.
  const slash = /^\/(\S*)$/.exec(str.slice(lineStart, caret));
  if (slash) {
    return { kind: "slash-command", query: slash[1]!, rangeStart: lineStart, rangeEnd: caret };
  }

  let begin = caret;
  while (begin > 0 && !isWhitespace(str[begin - 1]!)) begin -= 1;
  const tok = str.slice(begin, caret);
  if (tok.startsWith("$")) {
    return { kind: "skill", query: tok.slice(1), rangeStart: begin, rangeEnd: caret };
  }
  if (tok.startsWith("@")) {
    return { kind: "path", query: tok.slice(1), rangeStart: begin, rangeEnd: caret };
  }
  return null;
}

export function parseStandalonePromptSlashCommand(str: string): "plan" | "default" | null {
  const matched = /^\/(plan|default)$/i.exec(str.trim());
  return matched ? (matched[1]!.toLowerCase() as "plan" | "default") : null;
}

export function replaceTextRange(
  str: string,
  fromOffset: number,
  toOffset: number,
  replacement: string,
): { text: string; cursor: number } {
  const begin = Math.max(0, Math.min(fromOffset, str.length));
  const until = Math.max(begin, Math.min(toOffset, str.length));
  return {
    text: str.slice(0, begin) + replacement + str.slice(until),
    cursor: begin + replacement.length,
  };
}
