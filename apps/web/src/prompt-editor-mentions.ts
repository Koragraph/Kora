import { collectPromptInlineTokens } from "@kora/shared/promptInlineTokens";
import { collectContextChipReferences } from "@kora/shared/contextChipReferences";
import { collectAssistantFootnotes } from "@kora/shared/assistantFootnotes";
import type { ReplyFootnote } from "@kora/contracts";

export type PromptSegment =
  | { type: "text"; text: string }
  | { type: "mention"; path: string; source: string }
  | { type: "skill"; name: string }
  | { type: "citation"; citation: ReplyFootnote; source: string }
  | { type: "context-reference"; kind: string; contextId: string; label: string; source: string };

type BaseToken = ReturnType<typeof collectPromptInlineTokens>[number];
type EditorToken =
  | BaseToken
  | { type: "citation"; citation: ReplyFootnote; source: string; start: number; end: number }
  | {
      end: number;
      start: number;
      source: string;
      label: string;
      contextId: string;
      kind: string;
      type: "context-reference";
    };

export function collectPromptEditorInlineTokens(str: string): EditorToken[] {
  const fallbackBase = collectPromptInlineTokens(str);
  const citations = collectAssistantFootnotes(str);
  const refs = collectContextChipReferences(str);
  if (citations.length === 0 && refs.length === 0) return [...fallbackBase];

  const links: EditorToken[] = [
    ...citations.map((c) => ({
      type: "citation" as const,
      citation: c.citation,
      source: c.source,
      start: c.start,
      end: c.end,
    })),
    ...refs.map((res) => ({
      type: "context-reference" as const,
      kind: res.kind as string,
      contextId: res.contextId as string,
      label: res.label,
      source: res.source,
      start: res.start,
      end: res.end,
    })),
  ];
  // Links win: an unfinished @mention must not swallow the start of a link label.
  const survivors = fallbackBase.filter(
    (tok) => !links.some((link) => tok.start < link.end && tok.end > link.start),
  );
  return [...survivors, ...links].sort((earlier, later) => earlier.start - later.start);
}

const isSpace = (ch: string | undefined) =>
  ch !== undefined && (ch === " " || ch === "\n" || ch === "\t" || ch === "\r");

export function selectionTouchesMentionBoundary(
  promptText: string,
  begin: number,
  until: number,
): boolean {
  if (promptText.length === 0 || begin >= until) return false;
  const within = (pos: number) => pos >= begin && pos < until;
  return collectPromptEditorInlineTokens(promptText).some((tok) => {
    if (tok.type !== "mention") return false;
    const earlier = tok.start - 1;
    return (
      (earlier >= 0 && isSpace(promptText[earlier]) && within(earlier)) ||
      (isSpace(promptText[tok.end]) && within(tok.end))
    );
  });
}

export function splitPromptIntoPromptSegments(promptText: string): PromptSegment[] {
  if (promptText.length === 0) return [];
  const pieces: PromptSegment[] = [];
  const pushText = (str: string) => {
    if (!str) return;
    const last = pieces[pieces.length - 1];
    if (last?.type === "text") last.text += str;
    else pieces.push({ type: "text", text: str });
  };

  let caret = 0;
  for (const tok of collectPromptEditorInlineTokens(promptText)) {
    if (tok.start < caret) continue;
    pushText(promptText.slice(caret, tok.start));
    switch (tok.type) {
      case "mention":
        pieces.push({ type: "mention", path: tok.value, source: tok.source });
        break;
      case "skill":
        pieces.push({ type: "skill", name: tok.value });
        break;
      case "citation":
        pieces.push({ type: "citation", citation: tok.citation, source: tok.source });
        break;
      case "context-reference":
        pieces.push({
          type: "context-reference",
          kind: tok.kind,
          contextId: tok.contextId,
          label: tok.label,
          source: tok.source,
        });
        break;
    }
    caret = tok.end;
  }
  pushText(promptText.slice(caret));
  return pieces;
}
