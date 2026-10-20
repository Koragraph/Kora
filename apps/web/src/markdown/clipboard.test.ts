import { HostId, ItemId, ThreadId } from "@kora/contracts";
import { collectAssistantFootnotes, serializeReplyFootnote } from "@kora/shared/assistantFootnotes";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { serializeRenderedMarkdownFragment } from "./clipboard";

// A deliberately tiny DOM: only what the serializer reads (nodeType, tagName, childNodes, classList,
// attributes, textContent, querySelector for `tag`, `:scope > tag` and input[type=checkbox]).
interface Dom {
  nodeType: number;
  textContent: string;
  childNodes: Dom[];
  tagName?: string;
  [key: string]: unknown;
}

const TEXT = 3;
const ELEMENT = 1;

const t = (textContent: string): Dom => ({ nodeType: TEXT, textContent, childNodes: [] });

type Attrs = Record<string, string>;
interface Opts {
  cls?: string[];
  attrs?: Attrs;
}

function h(tagName: string, opts: Opts | null, ...kids: Array<Dom | string>): Dom {
  const childNodes = kids.map((k) => (typeof k === "string" ? t(k) : k));
  const attrs = opts?.attrs ?? {};
  const cls = opts?.cls ?? [];
  const self: Dom = {
    nodeType: ELEMENT,
    tagName,
    childNodes,
    get textContent() {
      return childNodes.map((c) => c.textContent).join("");
    },
    classList: { contains: (name: string) => cls.includes(name) },
    getAttribute: (name: string) => attrs[name] ?? null,
    hasAttribute: (name: string) => name in attrs,
    closest: () => null,
    querySelector(selector: string) {
      const direct = selector.startsWith(":scope > ");
      const want = direct ? selector.slice(9) : selector;
      const attr = (el: Dom, name: string) =>
        (el.getAttribute as (n: string) => string | null)(name);
      const hit = (el: Dom) => {
        if (want === 'input[type="checkbox"]') {
          return el.tagName === "INPUT" && attr(el, "type") === "checkbox";
        }
        if (want.startsWith("[")) return attr(el, want.slice(1, -1)) !== null;
        return el.tagName === want.toUpperCase();
      };
      const walk = (parent: Dom): Dom | null => {
        for (const kid of parent.childNodes) {
          if (kid.nodeType !== ELEMENT) continue;
          if (hit(kid)) return kid;
          const deeper = direct ? null : walk(kid);
          if (deeper) return deeper;
        }
        return null;
      };
      return walk(self);
    },
  } as Dom;
  return self;
}

const div = (...kids: Array<Dom | string>) => h("DIV", null, ...kids);
const copyAs = (markdown: string): Opts => ({ attrs: { "data-markdown-copy": markdown } });
const serialize = (root: Dom) => serializeRenderedMarkdownFragment(root as unknown as Node);

/** A rendered fenced block: a select-none header plus a highlighted pre with one `.line` span per line. */
function fencedBlock(...lines: string[]): Dom {
  const code = h("CODE", null);
  lines.forEach((text, i) => {
    if (i) code.childNodes.push(t("\n"));
    code.childNodes.push(h("SPAN", { cls: ["line"] }, h("SPAN", null, text)));
  });
  return h(
    "DIV",
    { cls: ["reply-md-codeblock"] },
    h("DIV", { cls: ["select-none"] }, "sh"),
    h("DIV", { cls: ["reply-md-shiki"] }, h("PRE", null, code)),
  );
}

beforeEach(() => {
  vi.stubGlobal("Node", { TEXT_NODE: TEXT, ELEMENT_NODE: ELEMENT });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("explicit copy overrides", () => {
  test("a button wrapping a span that carries the same reference yields it once", () => {
    const ref = "[Review comment](kora-context://v1/review-comment/review-1)";
    const root = div(
      "Fix ",
      h("BUTTON", copyAs(ref), h("SPAN", copyAs(ref), "Review comment")),
      " please",
    );
    expect(serialize(root)).toBe(`Fix ${ref} please`);
  });

  test("a card is copied as its declared markdown, not its visible pieces", () => {
    const card = h(
      "DIV",
      copyAs("Hello World (Document template)\n\n"),
      h("SPAN", null, "Hello World"),
      h("SPAN", null, "Document template"),
      h("BUTTON", null, "Use template"),
    );
    expect(serialize(div(card))).toBe("Hello World (Document template)");
  });

  test("a reply footnote chip round-trips through the footnote parser", () => {
    const citation = {
      suffix: "",
      prefix: "",
      end: 66,
      start: 0,
      comment: "What does this mean?\nPlease expand on the hidden part.",
      text: "A complete quote, including the part hidden by the chip preview.",
      messageId: ItemId.make("m-1"),
      threadId: ThreadId.make("th-1"),
      hostId: HostId.make("host-1"),
      version: 1 as const,
    };
    const payload = serializeReplyFootnote(citation);
    const chip = h(
      "SPAN",
      copyAs(payload),
      h(
        "A",
        { attrs: { href: "/host-1/th-1#c", "data-markdown-copy": payload } },
        "What does this mean?…",
      ),
      h("BUTTON", null, "Edit comment"),
    );
    const copied = serialize(div("Explain ", chip));
    expect(copied).toBe(`Explain ${payload}`);
    expect(collectAssistantFootnotes(copied).map((f) => f.citation)).toEqual([citation]);
  });
});

describe("code", () => {
  test("a fenced block beside prose keeps its fences", () => {
    const root = div(h("P", null, "Run this:"), fencedBlock("gh workflow run Deploy --ref main"));
    expect(serialize(root)).toBe("Run this:\n\n```\ngh workflow run Deploy --ref main\n```");
  });

  test("a lone block is copied bare, even with the empty start of the next paragraph attached", () => {
    const root = div(fencedBlock("echo $HOME | wc -c"), "\n", h("P", null, ""));
    expect(serialize(root)).toBe("echo $HOME | wc -c");
  });

  test("a code element without its pre stays plain when it spans lines", () => {
    expect(serialize(div(h("CODE", null, "one\ntwo")))).toBe("one\ntwo");
  });

  test("a highlighted line without its pre stays plain", () => {
    const code = h(
      "CODE",
      null,
      h("SPAN", { cls: ["line"] }, h("SPAN", null, "git fetch --all --prune")),
    );
    expect(serialize(div(code))).toBe("git fetch --all --prune");
  });

  test("inline code gets backticks", () => {
    const root = div(h("P", null, "run ", h("CODE", null, "git status"), " first"));
    expect(serialize(root)).toBe("run `git status` first");
  });

  test("inline code containing a backtick uses a longer fence", () => {
    expect(serialize(div(h("P", null, h("CODE", null, "a`b"))))).toBe("``a`b``");
  });

  test("a fence language comes from the class on the code element", () => {
    const pre = h("PRE", null, h("CODE", { attrs: { class: "language-ts" } }, "let x = 1;\n"));
    const root = div(h("P", null, "see:"), pre);
    expect(serialize(root)).toBe("see:\n\n```ts\nlet x = 1;\n```");
  });
});

describe("a block next to other content is not 'the only code'", () => {
  test("a chip with its own markdown copy", () => {
    const root = div(fencedBlock("pnpm test"), "\n", h("BUTTON", copyAs("`src/foo.ts`")));
    expect(serialize(root)).toBe("```\npnpm test\n```\n\n`src/foo.ts`");
  });

  test("a list item that only wraps the block is dropped, leaving the bare code", () => {
    const root = div(h("UL", null, h("LI", null, fencedBlock("pnpm test"))), "\n");
    expect(serialize(root)).toBe("pnpm test");
  });

  test("a task item whose only content is a checkbox", () => {
    const task = h("UL", null, h("LI", null, h("INPUT", { attrs: { type: "checkbox" } })));
    expect(serialize(div(task, fencedBlock("pnpm test")))).toBe("- [ ]\n\n```\npnpm test\n```");
  });

  test("an empty list item", () => {
    expect(serialize(div(h("UL", null, h("LI", null)), fencedBlock("pnpm test")))).toBe(
      "-\n\n```\npnpm test\n```",
    );
  });
});

describe("prose structure", () => {
  test("headings, emphasis and links", () => {
    const root = div(
      h("H2", null, "Title"),
      h(
        "P",
        null,
        "a ",
        h("STRONG", null, "bold "),
        h("EM", null, "it"),
        " ",
        h("A", { attrs: { href: "https://example.com" } }, "site"),
        h("A", { attrs: { href: "#local" } }, " anchor"),
      ),
    );
    expect(serialize(root)).toBe("## Title\n\na **bold** *it* [site](https://example.com) anchor");
  });

  test("a link whose text equals its url is emitted bare", () => {
    const link = h("A", { attrs: { href: "https://e.org" } }, "https://e.org");
    expect(serialize(div(h("P", null, link)))).toBe("https://e.org");
  });

  test("ordered lists honour start; bullets use dashes", () => {
    const root = div(
      h("OL", { attrs: { start: "4" } }, h("LI", null, "four"), h("LI", null, "five")),
      h("UL", null, h("LI", null, "dot")),
    );
    expect(serialize(root)).toBe("4. four\n5. five\n\n- dot");
  });

  test("checked boxes become [x]", () => {
    const box = h("INPUT", { attrs: { type: "checkbox", checked: "" } });
    expect(serialize(div(h("UL", null, h("LI", null, box, "done"))))).toBe("- [x] done");
  });

  test("blockquote lines are prefixed", () => {
    expect(serialize(div(h("BLOCKQUOTE", null, h("P", null, "one"), h("P", null, "two"))))).toBe(
      "> one\n>\n> two",
    );
  });

  test("tables become pipe tables with escaped pipes", () => {
    const table = h(
      "TABLE",
      null,
      h("THEAD", null, h("TR", null, h("TH", null, "a"), h("TH", null, "b"))),
      h("TBODY", null, h("TR", null, h("TD", null, "x|y"), h("TD", null, "2"))),
    );
    expect(serialize(div(table))).toBe("| a | b |\n| --- | --- |\n| x\\|y | 2 |");
  });

  test("interactive chrome (buttons, hidden nodes) is not copied", () => {
    const root = div(
      h(
        "P",
        null,
        "text",
        h("BUTTON", null, "Copy"),
        h("SPAN", { attrs: { "aria-hidden": "true" } }, "icon"),
      ),
    );
    expect(serialize(root)).toBe("text");
  });

  test("details keep summary, body and open state", () => {
    const open = h(
      "DIV",
      { attrs: { "data-markdown-details": "", "data-markdown-details-open": "true" } },
      h("BUTTON", { attrs: { "data-markdown-details-summary": "" } }, "More"),
      h("DIV", { attrs: { "data-markdown-details-content": "" } }, h("P", null, "inside")),
    );
    expect(serialize(div(open))).toBe(
      "<details open>\n<summary>More</summary>\n\ninside\n</details>",
    );
  });
});
