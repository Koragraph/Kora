import { directiveFromMarkdown } from "mdast-util-directive";
import { directive as genericDirective } from "micromark-extension-directive";
import { markdownLineEnding, markdownSpace, unicodePunctuation } from "micromark-util-character";
import type { Code, Construct, Extension, TokenizeContext, Tokenizer } from "micromark-util-types";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Plugin, Processor } from "unified";

import {
  type CodexArtifactTemplate,
  resolveCodexArtifactTemplate,
  codexArtifactTemplatePresentationLabel,
} from "./artifactTemplates.ts";
import { codexFileFootnoteMarkdown, resolveCodexFileFootnoteLink } from "./fileFootnotes.ts";

const FILE_CITATION = "codex-file-citation";
const ARTIFACT_TEMPLATE = "artifact-template";
const [COLON, DASH, UNDERSCORE] = [":", "-", "_"].map((mark) => mark.charCodeAt(0)) as [
  number,
  number,
  number,
];

const TEMPLATE_FLAG_PROPERTY = ["dataCodexArtifactTemplate"] as const;
const TEMPLATE_DISPLAY_PROPERTIES = [
  "dataDisplayName",
  "dataGalleryKind",
  "dataArtifactKind",
] as const;
export const CODEX_ARTIFACT_TEMPLATE_HAST_PROPERTIES = [
  ...TEMPLATE_FLAG_PROPERTY,
  ...TEMPLATE_DISPLAY_PROPERTIES,
  ...(["dataSkillDirectory", "dataSkillName"] as const),
] as const;

export type CodexArtifactTemplateMarkdownSegment =
  | {
      readonly template: CodexArtifactTemplate;
      readonly sourceOffset: number;
      readonly kind: "artifact-template";
    }
  | { readonly sourceOffset: number; readonly markdown: string; readonly kind: "markdown" };

// ---------------------------------------------------------------------------
// The restricted micromark grammar. The generic directive syntax would claim every `:foo` and
// `::bar` in user text, so each construct is gated on its one exact name.
// ---------------------------------------------------------------------------

/** After the name: end of input, a line ending, whitespace, or punctuation other than `-` and `_`. */
const endsName = (code: Code): boolean =>
  code === null ||
  markdownLineEnding(code) ||
  markdownSpace(code) ||
  (unicodePunctuation(code) && code !== DASH && code !== UNDERSCORE);

const gated = (construct: Construct, introducer: string): Construct => {
  const expected = introducer;
  const lookahead: Tokenizer = (effects, ok, nok) => {
    let index = 0;
    return function step(code) {
      if (index === 0) effects.enter("data");
      if (index < expected.length) {
        if (code !== expected.charCodeAt(index)) return nok(code);
        effects.consume(code);
        index += 1;
        return step;
      }
      effects.exit("data");
      return endsName(code) ? ok(code) : nok(code);
    };
  };
  const original = construct.tokenize;
  return {
    ...construct,
    tokenize(this: TokenizeContext, effects, ok, nok) {
      const start = original.call(this, effects, ok, nok);
      return effects.check({ tokenize: lookahead, partial: true }, start, nok);
    },
  };
};

const restrictedDirective = (): Extension => {
  const generic = genericDirective();
  const text = (generic.text as Record<number, Construct>)[COLON]!;
  const flow = (generic.flow as Record<number, ReadonlyArray<Construct>>)[COLON]!;
  const leaf = flow[flow.length - 1]!;
  return {
    text: { [COLON]: gated(text, `:${FILE_CITATION}`) },
    flow: { [COLON]: [gated(leaf, `::${ARTIFACT_TEMPLATE}`)] },
  };
};

// ---------------------------------------------------------------------------
// The tree transform
// ---------------------------------------------------------------------------

interface Point {
  readonly offset?: number | undefined;
}
interface MdNode {
  type: string;
  url?: string;
  value?: string;
  name?: string;
  attributes?: Record<string, string | null | undefined> | null | undefined;
  position?: { readonly start: Point; readonly end: Point } | undefined;
  data?: Record<string, unknown> | undefined;
  children?: MdNode[];
}

type Source = { readonly value: string };

const sliceOf = (node: MdNode, source: string): string | null => {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? null : source.slice(start, end);
};

/** The directive as the author wrote it, rebuilt from its parts when the source slice is unusable. */
const literalSource = (node: MdNode, source: string): string => {
  const slice = sliceOf(node, source);
  const prefix = node.type === "leafDirective" ? "::" : ":";
  if (slice !== null && slice.startsWith(`${prefix}${node.name}`)) return slice;
  const attributes = Object.entries(node.attributes ?? {})
    .map(([key, value]) =>
      value === "" || value == null ? key : `${key}=${JSON.stringify(value)}`,
    )
    .join(" ");
  return `${prefix}${node.name}${attributes ? `{${attributes}}` : ""}`;
};

const asText = (node: MdNode, source: string): MdNode => ({
  type: "text",
  value: literalSource(node, source),
  ...(node.position === undefined ? {} : { position: node.position }),
});

const templateProperties = (template: CodexArtifactTemplate): Record<string, string> => ({
  dataSkillName: template.skillName,
  dataSkillDirectory: template.skillDirectory,
  ...(template.galleryKind === undefined ? {} : { dataGalleryKind: template.galleryKind }),
  dataDisplayName: template.displayName,
  dataArtifactKind: template.artifactKind,
  dataCodexArtifactTemplate: "true",
});

const convert = (node: MdNode, source: string, insideLink: boolean): MdNode => {
  if (node.type === "textDirective" && node.name === FILE_CITATION) {
    const citation = insideLink ? null : resolveCodexFileFootnoteLink(node.attributes);
    if (citation === null) return asText(node, source);
    return {
      type: "link",
      url: citation.href,
      children: [{ type: "text", value: citation.label }],
      ...(node.position === undefined ? {} : { position: node.position }),
      data: { codexFileFootnoteMarkdown: codexFileFootnoteMarkdown(citation) },
    };
  }

  if (node.type === "leafDirective" && node.name === ARTIFACT_TEMPLATE) {
    const template = resolveCodexArtifactTemplate(node.attributes);
    if (template === null) {
      return {
        type: "paragraph",
        children: [asText(node, source)],
        ...(node.position === undefined ? {} : { position: node.position }),
      };
    }
    return {
      type: "paragraph",
      children: [],
      ...(node.position === undefined ? {} : { position: node.position }),
      data: {
        hName: "div",
        hProperties: templateProperties(template),
        codexArtifactTemplate: template,
      },
    };
  }

  if (node.children) {
    const nowInside = insideLink || node.type === "link" || node.type === "linkReference";
    node.children = mergeText(node.children.map((child) => convert(child, source, nowInside)));
  }
  return node;
};

/** Restored literal text rejoins its neighbours, as it would in an ordinary parse. */
const mergeText = (nodes: MdNode[]): MdNode[] => {
  const merged: MdNode[] = [];
  for (const node of nodes) {
    const previous = merged[merged.length - 1];
    if (previous?.type === "text" && node.type === "text" && !previous.data && !node.data) {
      const position =
        previous.position && node.position
          ? { start: previous.position.start, end: node.position.end }
          : undefined;
      merged[merged.length - 1] = {
        type: "text",
        value: `${previous.value ?? ""}${node.value ?? ""}`,
        ...(position ? { position } : {}),
      };
    } else {
      merged.push(node);
    }
  }
  return merged;
};

export const remarkCodexDirectives: Plugin<[]> = function (this: Processor) {
  const data = this.data() as Record<string, unknown[] | undefined>;
  (data.micromarkExtensions ??= []).push(restrictedDirective());
  (data.fromMarkdownExtensions ??= []).push(directiveFromMarkdown());
  const transform = (tree: MdNode, file: Source): MdNode =>
    convert(tree, String(file.value), false);
  return transform as never;
};

// ---------------------------------------------------------------------------
// String adapters
// ---------------------------------------------------------------------------

const parser = unified().use(remarkParse).use(remarkCodexDirectives).freeze();

const parseDirectives = (markdown: string): MdNode => {
  const tree = parser.parse(markdown);
  return parser.runSync(tree, { value: markdown } as never) as unknown as MdNode;
};

interface Replacement {
  readonly text: string;
  readonly end: number;
  readonly start: number;
}

const collectReplacements = (
  node: MdNode,
  render: (node: MdNode) => string | null,
  into: Replacement[],
): void => {
  const text = render(node);
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (text !== null && start !== undefined && end !== undefined) {
    into.push({ start, end, text });
    return;
  }
  for (const child of node.children ?? []) collectReplacements(child, render, into);
};

/** Apply right to left so earlier offsets stay valid. */
const applyReplacements = (markdown: string, replacements: Replacement[]): string => {
  let out = markdown;
  for (const { start, end, text } of replacements.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, start) + text + out.slice(end);
  }
  return out;
};

const fileCitationMarkdown = (node: MdNode): string | null =>
  node.type === "link" && typeof node.data?.codexFileFootnoteMarkdown === "string"
    ? node.data.codexFileFootnoteMarkdown
    : null;

export function renderCodexFileFootnotesAsMarkdown(markdown: string): string {
  if (!markdown.includes(`:${FILE_CITATION}`)) return markdown;
  const replacements: Replacement[] = [];
  collectReplacements(
    parseDirectives(markdown),
    (node) => fileCitationMarkdown(node),
    replacements,
  );
  return applyReplacements(markdown, replacements);
}

export function renderCodexDirectivesForCopy(markdown: string): string {
  if (!markdown.includes(`:${FILE_CITATION}`) && !markdown.includes(`::${ARTIFACT_TEMPLATE}`)) {
    return markdown;
  }
  const replacements: Replacement[] = [];
  collectReplacements(
    parseDirectives(markdown),
    (node) => {
      const citation = fileCitationMarkdown(node);
      if (citation !== null) return citation;
      const template = node.data?.codexArtifactTemplate as CodexArtifactTemplate | undefined;
      return template === undefined
        ? null
        : `${template.displayName} (${codexArtifactTemplatePresentationLabel(template.artifactKind)})`;
    },
    replacements,
  );
  return applyReplacements(markdown, replacements);
}

type HastProperties = Readonly<Record<string, unknown>> | null | undefined;

export function artifactTemplateFromHastProperties(
  properties: HastProperties,
): CodexArtifactTemplate | null {
  if (properties?.dataCodexArtifactTemplate !== "true") return null;
  const stringProp = (key: string): string | undefined => {
    const raw = properties[key];
    return typeof raw === "string" ? raw : undefined;
  };
  return resolveCodexArtifactTemplate({
    skill_name: stringProp("dataSkillName"),
    skill_directory: stringProp("dataSkillDirectory"),
    gallery_kind: stringProp("dataGalleryKind"),
    display_name: stringProp("dataDisplayName"),
    artifact_kind: stringProp("dataArtifactKind"),
  });
}
