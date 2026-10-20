/**
 * Positions in the prompt editor as plain-text offsets.
 *
 * The editor holds one paragraph of text nodes, line breaks and inline chips. A chip's text is its canonical link
 * (`[README.md](README.md)`, a skill's `$name`, ...), so the prompt string is the root's text content. Offsets come
 * in two measures:
 * - "expanded": a chip counts as its full text. This is an index into the prompt string.
 * - "collapsed": a chip counts as one character, the way the caret steps over it. The composer's stored cursor
 *   uses this measure (`prompt-logic` converts between the two on the string alone).
 */
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $setSelection,
} from "lexical";
import { $getRoot, $createTextNode, $getSelection } from "lexical";
import { $isElementNode, $isLineBreakNode, $isRangeSelection, $isTextNode } from "lexical";
import type { BaseSelection, ElementNode, LexicalNode } from "lexical";
import { formatAgentSkillDisplayName } from "@kora/client-runtime/agentSkills";

import { splitPromptIntoPromptSegments } from "~/prompt-editor-mentions";
import { $createCitationChipNode } from "./citationChip";
import { $createContextRefChipNode, ContextRefChipNode } from "./contextRefChip";
import { $createFileChipNode, $createSkillChipNode, type SkillChipDetails } from "./chips";
import { isChipNode } from "./inlineChip";

export type Measure = "collapsed" | "expanded";

/** Length of `node` (and everything inside it) in `measure`. */
export function lengthOf(node: LexicalNode, measure: Measure): number {
  if (isChipNode(node)) return measure === "collapsed" ? 1 : node.getTextContentSize();
  if ($isTextNode(node)) return node.getTextContentSize();
  if ($isLineBreakNode(node)) return 1;
  if ($isElementNode(node)) {
    let total = 0;
    for (const child of node.getChildren()) total += lengthOf(child, measure);
    return total;
  }
  return 0;
}

/** The text offset of a selection point (`node`, `pointOffset`) from the start of the prompt. */
export function offsetOfPoint(node: LexicalNode, pointOffset: number, measure: Measure): number {
  // Everything before the node: the earlier siblings of the node and of each of its ancestors.
  let before = 0;
  for (let at: LexicalNode = node, parent = at.getParent(); $isElementNode(parent);) {
    const siblings = parent.getChildren();
    for (let i = 0; i < at.getIndexWithinParent(); i++) {
      const sibling = siblings[i];
      if (sibling) before += lengthOf(sibling, measure);
    }
    at = parent;
    parent = at.getParent();
  }
  // Then how far into the node the point is.
  if ($isTextNode(node)) return before + Math.min(pointOffset, node.getTextContentSize());
  if (isChipNode(node)) return before + (pointOffset > 0 ? lengthOf(node, measure) : 0);
  if ($isLineBreakNode(node)) return before + Math.min(pointOffset, 1);
  if ($isElementNode(node)) {
    const children = node.getChildren();
    const upTo = Math.max(0, Math.min(pointOffset, children.length));
    for (let i = 0; i < upTo; i++) {
      const child = children[i];
      if (child) before += lengthOf(child, measure);
    }
  }
  return before;
}

type Point = { key: string; offset: number; type: "text" | "element" };

/**
 * The selection point `left` collapsed characters into `node`, or null when the offset lies past it (and `left` has
 * been reduced by the node's length). A chip or line break is one unit, addressed from its parent element.
 */
function pointWithin(node: LexicalNode, left: { n: number }): Point | null {
  if ($isTextNode(node)) {
    const size = node.getTextContentSize();
    if (left.n <= size) return { key: node.getKey(), offset: left.n, type: "text" };
    left.n -= size;
    return null;
  }
  if (isChipNode(node) || $isLineBreakNode(node)) {
    const parent = node.getParent();
    if (!parent || (isChipNode(node) && !$isElementNode(parent))) return null;
    if (left.n === 0 || left.n === 1) {
      return {
        key: parent.getKey(),
        offset: node.getIndexWithinParent() + left.n,
        type: "element",
      };
    }
    left.n -= 1;
    return null;
  }
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      const match = pointWithin(child, left);
      if (match) return match;
    }
    if (left.n === 0)
      return { key: node.getKey(), offset: node.getChildrenSize(), type: "element" };
  }
  return null;
}

/** The collapsed length of the whole prompt. */
export function $promptLength(): number {
  return lengthOf($getRoot(), "collapsed");
}

function $pointAt(offset: number): Point {
  const root = $getRoot();
  const bounded = Math.max(0, Math.min(offset, $promptLength()));
  return (
    pointWithin(root, { n: bounded }) ?? {
      key: root.getKey(),
      offset: root.getChildrenSize(),
      type: "element",
    }
  );
}

/** Selects collapsed offsets `start`..`end` (a caret when they are equal), clamped to the prompt. */
export function $selectRange(start: number, end = start): void {
  const [anchor, focus] = [$pointAt(start), $pointAt(end)];
  const selection = $createRangeSelection();
  selection.anchor.set(anchor.key, anchor.offset, anchor.type);
  selection.focus.set(focus.key, focus.offset, focus.type);
  $setSelection(selection);
}

/** Where a collapsed caret is, in `measure`, clamped to the prompt; `fallback` when there is no single caret. */
export function $caretOffset(measure: Measure, fallback: number): number {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return fallback;
  const at = offsetOfPoint(selection.anchor.getNode(), selection.anchor.offset, measure);
  const total = measure === "collapsed" ? $promptLength() : $getRoot().getTextContentSize();
  return Math.max(0, Math.min(at, total));
}

/** A range selection as ordered expanded offsets (indices into the prompt string), else null. */
export function expandedRangeOf(
  selection: BaseSelection | null,
): { start: number; end: number } | null {
  if (!$isRangeSelection(selection)) return null;
  const a = offsetOfPoint(selection.anchor.getNode(), selection.anchor.offset, "expanded");
  const b = offsetOfPoint(selection.focus.getNode(), selection.focus.offset, "expanded");
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

export function selectionHasChip(selection: BaseSelection | null): boolean {
  return $isRangeSelection(selection) && selection.getNodes().some(isChipNode);
}

/** Appends `text` to `parent`, turning each "\n" into a line break node. */
export function $appendPlainText(parent: ElementNode, text: string): void {
  text.split("\n").forEach((line, index) => {
    if (index > 0) parent.append($createLineBreakNode());
    if (line !== "") parent.append($createTextNode(line));
  });
}

/** Replaces the editor's content with `prompt`, turning each token in it into its chip. */
export function $writePrompt(prompt: string, skills: ReadonlyMap<string, SkillChipDetails>): void {
  const paragraph = $createParagraphNode();
  $getRoot().clear().append(paragraph);
  for (const segment of splitPromptIntoPromptSegments(prompt)) {
    switch (segment.type) {
      case "mention":
        paragraph.append($createFileChipNode(segment.path, segment.source));
        break;
      case "citation":
        paragraph.append($createCitationChipNode(segment.citation, segment.source));
        break;
      case "skill": {
        const known = skills.get(segment.name);
        paragraph.append(
          $createSkillChipNode(segment.name, {
            label: known?.label ?? formatAgentSkillDisplayName({ name: segment.name }),
            description: known?.description ?? null,
          }),
        );
        break;
      }
      case "context-reference":
        paragraph.append(
          $createContextRefChipNode({
            kind: segment.kind,
            label: segment.label,
            contextId: segment.contextId,
          }),
        );
        break;
      default:
        $appendPlainText(paragraph, segment.text);
    }
  }
}

/** The context ids the chips under `node` point at, each once, in the order they first appear. */
export function contextIdsIn(node: LexicalNode): string[] {
  const ids = new Set<string>();
  const visit = (at: LexicalNode) => {
    if (at instanceof ContextRefChipNode) ids.add(at.getReference().contextId);
    else if ($isElementNode(at)) at.getChildren().forEach(visit);
  };
  visit(node);
  return [...ids];
}
