import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import * as Directives from "./markdownDirectives.ts";

type Offset = { readonly offset?: number };
type HastHints = {
  readonly hName?: string;
  readonly hProperties?: Readonly<Record<string, unknown>>;
};
/** Just enough of an mdast node to inspect. */
type Node = Partial<Readonly<Record<"value" | "url", string>>> & {
  readonly type: string;
  readonly children?: readonly Node[];
  readonly data?: HastHints;
  readonly position?: Readonly<Record<"start" | "end", Offset>>;
};

const CITATION = ':codex-file-citation{path="build/summary.csv" purpose="output"}';
const TEMPLATE = [
  "::artifact-template{",
  'skill_name="artifact-template-slide-deck" ',
  'skill_directory="/home/dev/.codex/skills/artifact-template-slide-deck" ',
  'display_name="Slide deck" ',
  'artifact_kind="document"}',
].join("");

const withDirectives = (markdown: string) => {
  const processor = unified().use(remarkParse).use(remarkCodexDirectives);
  return processor.runSync(processor.parse(markdown), { value: markdown }) as Node;
};
const plain = (markdown: string) => unified().use(remarkParse).parse(markdown) as Node;
const { remarkCodexDirectives } = Directives;

describe("directive parsing", () => {
  it("turns a file citation into a link that keeps the citation's source range", () => {
    const markdown = `Wrote ${CITATION} just now.`;
    const start = markdown.indexOf(CITATION);
    const link = withDirectives(markdown).children?.[0]?.children?.[1];
    expect(link).toMatchObject({
      type: "link",
      url: "build/summary.csv",
      children: [{ type: "text", value: "summary.csv" }],
      position: { start: { offset: start }, end: { offset: start + CITATION.length } },
    });
  });

  it("turns an artifact template into a block carrying its metadata", () => {
    const block = withDirectives(TEMPLATE).children?.[0];
    expect([block?.type, block?.children, block?.data?.hName]).toEqual(["paragraph", [], "div"]);
    expect(block?.data?.hProperties).toMatchObject({
      dataSkillName: "artifact-template-slide-deck",
      dataDisplayName: "Slide deck",
      dataArtifactKind: "document",
      dataCodexArtifactTemplate: "true",
    });
  });

  it.each([
    "Lunch at 12:15",
    "See lib/run.py:12",
    "Style :focus and say :wave:",
    "::aside",
    ":::aside\nbody\n:::",
    ':codex-file-citation-x{path="build/summary.csv"}',
    "::artifact-template-x",
    // Supported names without the required attributes stay literal too.
    ':codex-file-citation{purpose="output"}',
    '::artifact-template{skill_name="artifact-template-slide-deck"}',
  ])("leaves %j exactly as plain markdown parses it", (markdown) => {
    expect(withDirectives(markdown)).toEqual(plain(markdown));
  });
});

describe("markdown adapters", () => {
  it("renders citations as portable links with the same parser", () => {
    expect(Directives.renderCodexFileFootnotesAsMarkdown(`Wrote ${CITATION} just now.`)).toBe(
      "Wrote [summary.csv](<build/summary.csv>) just now.",
    );
  });

  it.each([
    ["escaped", `\\${CITATION}`],
    ["inline code", `\`${CITATION}\``],
    ["a code block", `\`\`\`txt\n${CITATION}\n\`\`\``],
    ["link text", `[Look at ${CITATION}](https://example.org)`],
  ])("leaves a citation in %s alone", (_label, markdown) => {
    expect(Directives.renderCodexFileFootnotesAsMarkdown(markdown)).toBe(markdown);
  });

  it("copies chips and template cards as the markdown they stand for", () => {
    const source = `Wrote ${CITATION} just now.\n\n${TEMPLATE}`;
    expect(Directives.renderCodexDirectivesForCopy(source)).toBe(
      "Wrote [summary.csv](<build/summary.csv>) just now.\n\nSlide deck (Document template)",
    );
  });

  it("copies excluded and malformed directives unchanged", () => {
    const source = `\`${CITATION}\`\n\n::artifact-template{display_name="Slide deck"}`;
    expect(Directives.renderCodexDirectivesForCopy(source)).toBe(source);
  });
});
