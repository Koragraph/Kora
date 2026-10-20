import type { ContextChipId, ContextTagKind } from "@kora/contracts";
import {
  replaceContextChipReferences,
  formatContextChipReference,
  collectContextChipReferences,
} from "@kora/shared/contextChipReferences";

export interface ContextChipReference {
  kind: ContextTagKind;
  contextId: string;
  label: string;
}

const VALID_ID = /^[a-z0-9_-]{1,128}$/i;
const SLUG_MAX = 48;

/** 32-bit FNV-1a over UTF-16 code units, walked forwards or backwards. */
function fnv1a(str: string, basis: number, backwards: boolean): string {
  let hash = basis >>> 0;
  for (let n = 0; n < str.length; n++) {
    const code = str.charCodeAt(backwards ? str.length - 1 - n : n);
    hash = Math.imul(hash ^ code, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Producer ids are arbitrary strings; chip ids must survive a Markdown link and the wire
 * grammar. Ids that already fit pass through, others become slug + a stable 16-hex digest
 * (persisted in messages, so the digest must never change).
 */
export function toContextChipId(producerId: string): ContextChipId {
  if (VALID_ID.test(producerId)) return producerId as ContextChipId;
  const idSlug =
    producerId
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX) || "ctx";
  const digest = fnv1a(producerId, 0x811c9dc5, false) + fnv1a(producerId, 0x9dc5811c, true);
  return `${idSlug}-${digest}` as ContextChipId;
}

export function toKindScopedContextChipId(
  variant: ContextTagKind,
  producerId: string,
): ContextChipId {
  return toContextChipId(`${variant}_${producerId}`);
}

export function producerIdFromContextChipId(variant: ContextTagKind, contextId: string): string {
  const prefix = `${variant}_`;
  return contextId.startsWith(prefix) ? contextId.slice(prefix.length) : contextId;
}

export const formatInlineContextLink = (reference: ContextChipReference): string =>
  formatContextChipReference(reference as Parameters<typeof formatContextChipReference>[0]);

export function collectInlineContextIds(promptText: string): string[] {
  return [
    ...new Set(collectContextChipReferences(promptText).map((obj) => obj.contextId as string)),
  ];
}

export function stripInlineContextLinks(promptText: string): string {
  return replaceContextChipReferences(promptText, () => "");
}

const isBlank = (ch: string | undefined) => ch === " " || ch === "\n" || ch === "\t" || ch === "\r";

export function inlineContextReferenceReplacement(
  promptText: string,
  picked: { start: number; end: number },
  refs: ReadonlyArray<ContextChipReference>,
): { start: number; end: number; text: string } {
  const begin = Math.min(promptText.length, Math.max(0, Math.floor(picked.start)));
  let until = Math.min(promptText.length, Math.max(begin, Math.floor(picked.end)));
  const earlier = begin > 0 ? promptText[begin - 1] : undefined;
  const lead = earlier === undefined || isBlank(earlier) ? "" : " ";
  const str = `${lead}${refs.map(formatInlineContextLink).join(" ")} `;
  // The inserted trailing space stands in for one that was already there.
  if (promptText[until] === " ") until += 1;
  return { start: begin, end: until, text: str };
}

export function insertInlineContextLink(
  promptText: string,
  cursorInput: number,
  reference: ContextChipReference,
): { prompt: string; cursor: number } {
  const edit = inlineContextReferenceReplacement(
    promptText,
    { start: cursorInput, end: cursorInput },
    [reference],
  );
  return {
    prompt: promptText.slice(0, edit.start) + edit.text + promptText.slice(edit.end),
    cursor: edit.start + edit.text.length,
  };
}

export const appendInlineContextLink = (
  promptText: string,
  reference: ContextChipReference,
): string => insertInlineContextLink(promptText, promptText.length, reference).prompt;

export function removeInlineContextLink(
  promptText: string,
  contextId: string,
): { prompt: string; cursor: number } {
  const hits = collectContextChipReferences(promptText).filter(
    (obj) => obj.contextId === contextId,
  );
  if (hits.length === 0) return { prompt: promptText, cursor: promptText.length };

  let edited = promptText;
  let caret = promptText.length;
  // Last to first keeps earlier offsets valid.
  for (const hit of [...hits].reverse()) {
    let cutStart = hit.start;
    let cutEnd = hit.end;
    if (edited[cutEnd] === " ") cutEnd += 1;
    else if (cutStart > 0 && edited[cutStart - 1] === " ") cutStart -= 1;
    edited = edited.slice(0, cutStart) + edited.slice(cutEnd);
    caret = cutStart;
  }
  if (caret >= edited.length) {
    edited = edited.trimEnd();
    caret = edited.length;
  }
  return { prompt: edited, cursor: caret };
}

export function ensureInlineContextLinks(
  promptText: string,
  refs: ReadonlyArray<ContextChipReference>,
): string {
  let result = promptText;
  const present = new Set(collectInlineContextIds(result));
  for (const reference of refs) {
    if (present.has(reference.contextId)) continue;
    present.add(reference.contextId);
    result = appendInlineContextLink(result, reference);
  }
  return result;
}
