import { formatContextChipReference } from "@kora/shared/contextChipReferences";
import type { ThreadId } from "@kora/contracts";

import { toKindScopedContextChipId } from "./contextChipReferences";

export interface TerminalExcerptSelection {
  text: string;
  lineEnd: number;
  lineStart: number;
  terminalLabel: string;
  terminalId: string;
}

export interface TerminalExcerptDraft extends TerminalExcerptSelection {
  createdAt: string;
  threadId: ThreadId;
  id: string;
}

/** Legacy ordinal placeholder from drafts saved before context references. Migration only. */
export const INLINE_TERMINAL_CONTEXT_PLACEHOLDER = "\uFFFC";

export interface TerminalExcerptReferenceSource {
  lineEnd: number;
  lineStart: number;
  terminalLabel: string;
  id: string;
}

/** The canonical inline link that stands for this context in the prompt. */
export function formatTerminalExcerptReference(context1: TerminalExcerptReferenceSource): string {
  return formatContextChipReference({
    kind: "terminal",
    contextId: toKindScopedContextChipId("terminal", context1.id),
    label: formatTerminalExcerptLabel(context1),
  });
}

export function normalizeTerminalExcerptText(str: string): string {
  return str.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

export function hasTerminalExcerptText(context1: { text: string }): boolean {
  return normalizeTerminalExcerptText(context1.text).length > 0;
}

export function isTerminalExcerptExpired(context1: { text: string }): boolean {
  return !hasTerminalExcerptText(context1);
}

export function filterTerminalExcerptsWithText<T extends { text: string }>(
  scopes: ReadonlyArray<T>,
): T[] {
  return scopes.filter((context1) => hasTerminalExcerptText(context1));
}

function formatTerminalExcerptRange(picked: { lineStart: number; lineEnd: number }): string {
  return picked.lineStart === picked.lineEnd
    ? `line ${picked.lineStart}`
    : `lines ${picked.lineStart}-${picked.lineEnd}`;
}

export function formatTerminalExcerptLabel(picked: {
  lineEnd: number;
  lineStart: number;
  terminalLabel: string;
}): string {
  return `${picked.terminalLabel} ${formatTerminalExcerptRange(picked)}`;
}

/** Binds legacy U+FFFC placeholders to contexts in array order; leftover placeholders vanish. */
export function migrateLegacyTerminalExcerptPlaceholders(
  promptText: string,
  scopes: ReadonlyArray<TerminalExcerptReferenceSource>,
): string {
  if (!promptText.includes(INLINE_TERMINAL_CONTEXT_PLACEHOLDER)) return promptText;
  let pos = 0;
  return promptText.replaceAll(INLINE_TERMINAL_CONTEXT_PLACEHOLDER, () => {
    const context1 = scopes[pos];
    pos += 1;
    return context1 ? formatTerminalExcerptReference(context1) : "";
  });
}
