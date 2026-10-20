import { type KnownContextChipKind, CONTEXT_CHIP_KINDS } from "@kora/contracts";

export interface ContextDisplayCapability {
  expanded: "none" | "inline-block" | "modal";
  defaultDraftView: "compact" | "expanded";
  details: "none" | "tooltip" | "popover";
}

export interface ContextDisplayDefinition {
  kind: KnownContextChipKind;
  capabilities: ContextDisplayCapability;
}

const capability = (
  details: ContextDisplayCapability["details"],
  expanded: ContextDisplayCapability["expanded"] = "none",
): ContextDisplayCapability => ({ details, expanded, defaultDraftView: "compact" });

const DEFINITION_LIST: ReadonlyArray<ContextDisplayDefinition> = [
  { kind: "terminal", capabilities: capability("popover") },
  { kind: "element", capabilities: capability("popover") },
  { kind: "preview-annotation", capabilities: capability("popover", "modal") },
  { kind: "review-comment", capabilities: capability("popover") },
  { kind: "mention", capabilities: capability("none") },
  { kind: "skill", capabilities: capability("tooltip") },
];

function indexDefinitions(): ReadonlyMap<KnownContextChipKind, ContextDisplayDefinition> {
  const byKind = new Map<KnownContextChipKind, ContextDisplayDefinition>();
  for (const definition of DEFINITION_LIST) {
    if (byKind.has(definition.kind)) {
      throw new Error(`Duplicate context presentation definition: ${definition.kind}`);
    }
    byKind.set(definition.kind, definition);
  }
  // Re-emit in the contract's kind order so consumers can rely on it.
  const ordered = new Map<KnownContextChipKind, ContextDisplayDefinition>();
  for (const kind of CONTEXT_CHIP_KINDS) {
    const definition = byKind.get(kind);
    if (!definition) throw new Error(`Missing context presentation definition: ${kind}`);
    ordered.set(kind, definition);
  }
  return ordered;
}

export const CONTEXT_PRESENTATION_DEFINITIONS = indexDefinitions();

export function contextPresentationDefinition(
  chipKind: KnownContextChipKind,
): ContextDisplayDefinition {
  return CONTEXT_PRESENTATION_DEFINITIONS.get(chipKind)!;
}

export interface ContextDisplayHandler<TRecord, TRenderContext, TResult> {
  canRender?: (record: TRecord, context: TRenderContext) => boolean;
  render: (
    record: TRecord,
    renderContext: TRenderContext,
    presentation: ContextDisplayDefinition,
  ) => TResult;
  kind: KnownContextChipKind;
}

export interface ContextDisplayRegistry<TRecord, TRenderContext, TResult> {
  definition(kind: KnownContextChipKind): ContextDisplayDefinition;
  render(kind: string, record: TRecord | undefined, context: TRenderContext): TResult;
}

export function createContextDisplayRegistry<TRecord, TRenderContext, TResult>(options: {
  fallback: (kind: string, record: TRecord | undefined, context: TRenderContext) => TResult;
  handlers: ReadonlyArray<ContextDisplayHandler<TRecord, TRenderContext, TResult>>;
  requiredKinds?: ReadonlyArray<KnownContextChipKind>;
}): ContextDisplayRegistry<TRecord, TRenderContext, TResult> {
  const handlers = new Map<string, ContextDisplayHandler<TRecord, TRenderContext, TResult>>();
  for (const handler of options.handlers) {
    const alreadyRegistered = handlers.has(handler.kind);
    if (alreadyRegistered) {
      throw new Error(`Duplicate context presentation handler: ${handler.kind}`);
    }
    handlers.set(handler.kind, handler);
  }
  (options.requiredKinds ?? []).forEach((kind) => {
    if (!handlers.has(kind)) throw new Error(`Missing context presentation handler: ${kind}`);
  });

  return {
    definition: contextPresentationDefinition,
    render(kind, record, context) {
      const handler = handlers.get(kind);
      const declined =
        handler !== undefined &&
        record !== undefined &&
        handler.canRender?.(record, context) === false;
      if (handler === undefined || record === undefined || declined) {
        return options.fallback(kind, record, context);
      }
      return handler.render(record, context, contextPresentationDefinition(handler.kind));
    },
  };
}
