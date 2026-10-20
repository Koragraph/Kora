import type { ContextChipId } from "@kora/contracts";
import { formatContextChipReference } from "@kora/shared/contextChipReferences";
import { $applyNodeReplacement } from "lexical";
import type { NodeKey, SerializedLexicalNode, Spread } from "lexical";
import type { ReactElement } from "react";

import { randomUUID } from "~/util/utils";
import { ContextChipReferenceChip } from "../contextChipPresentation";
import { InlineChipNode } from "./inlineChip";

/** What a context chip points at: a record in the draft (an image, a terminal excerpt, a review comment, ...). */
export interface ContextRef {
  kind: string;
  label: string;
  contextId: string;
}

export type ContextRefChipJSON = Spread<
  ContextRef & { type: "prompt-context-ref"; version: 1; referenceId: string },
  SerializedLexicalNode
>;

/**
 * One place in the prompt that refers to a context record. Its text is the canonical link, which carries kind and
 * id, so rebuilding the editor from the prompt string gives back the same chip. `referenceId` names this one
 * occurrence; a copy of the node gets a fresh one.
 */
export class ContextRefChipNode extends InlineChipNode {
  __ref: ContextRef;
  __referenceId: string;

  static override getType(): "prompt-context-ref" {
    return "prompt-context-ref";
  }

  static override clone(from: ContextRefChipNode): ContextRefChipNode {
    return new ContextRefChipNode({ ...from.__ref }, from.__referenceId, from.__key);
  }

  static override importJSON(json: ContextRefChipJSON): ContextRefChipNode {
    const { kind, label, contextId } = json;
    return $createContextRefChipNode({ kind, label, contextId }, json.referenceId).updateFromJSON(
      json,
    );
  }

  constructor(ref: ContextRef, referenceId: string, key?: NodeKey) {
    super(key);
    this.__ref = { kind: ref.kind, label: ref.label, contextId: ref.contextId };
    this.__referenceId = referenceId;
  }

  protected override hostClasses(): string {
    return "max-w-full";
  }

  getReference(): ContextRef {
    return { ...this.getLatest().__ref };
  }

  override exportJSON(): ContextRefChipJSON {
    const latest = this.getLatest();
    return {
      ...super.exportJSON(),
      ...latest.__ref,
      referenceId: latest.__referenceId,
      type: "prompt-context-ref",
      version: 1,
    };
  }

  override getTextContent(): string {
    const ref = this.getLatest().__ref;
    return formatContextChipReference({ ...ref, contextId: ref.contextId as ContextChipId });
  }

  override decorate(): ReactElement {
    return <ContextChipReferenceChip {...this.getLatest().__ref} />;
  }
}

export function $createContextRefChipNode(
  ref: ContextRef,
  referenceId: string = randomUUID(),
): ContextRefChipNode {
  return $applyNodeReplacement(new ContextRefChipNode(ref, referenceId));
}
