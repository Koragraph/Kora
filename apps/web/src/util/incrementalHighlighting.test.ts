import { getSharedHighlighter } from "@pierre/diffs";
import { toHtml } from "hast-util-to-html";
import { describe, expect, test } from "vite-plus/test";

import { createIncrementalHighlightedDocument } from "./incrementalHighlighting";

const THEMES = ["pierre-dark", "pierre-light"] as const;
const PLAIN_LANGS = ["text", "plaintext", "plain", "txt", "ansi"];

// Each sample has a construct that spans lines, so grammar state matters.
const SAMPLES: Record<string, string> = {
  sql: "SELECT 'two\nlines'\nFROM t;\n",
  css: '/* note\n more */\na::after {\n content: "x";\n}\n',
  yaml: "k: |\n  body\n  more\nnext: 1\n",
  json: '{\n "v": [1,\n 2]\n}\n',
  tsx: 'const el = <p\n id="a">\n{v}\n</p>;\n',
  rust: 'fn f() {\n let s = r#"a\nb"#;\n}\n',
  markdown: "# h\n\n```ts\nlet a = 1;\n```\n\nend\n",
  html: "<script>\nlet x = 1;\n</script>\n<style>\na {color:red;}\n</style>\n",
  bash: "#!/bin/bash\ncat <<EOT\nhi\nEOT\necho ok\n",
  python: '#!/usr/bin/python\ns = """a\nb"""\nprint(s)\n',
  typescript: "/* a\nb */\nconst s = `x\n${1 + 2}`;\nconst re = /q/;\n",
};

const shiki = getSharedHighlighter({
  preferredHighlighter: "shiki-wasm",
  themes: [...THEMES],
  langs: Object.keys(SAMPLES) as never,
});

async function bothRenderers(lang: string, theme: (typeof THEMES)[number]) {
  const engine = await shiki;
  const incremental = createIncrementalHighlightedDocument(engine, lang, theme);
  return {
    streamed: (text: string) => toHtml(incremental(text)),
    whole: (text: string) => engine.codeToHtml(text, { lang, theme }),
  };
}

describe("incremental highlighting", () => {
  test.each(Object.keys(SAMPLES))(
    "%s: every growing prefix equals a one-shot render",
    async (lang) => {
      const source = SAMPLES[lang]!;
      for (const theme of THEMES) {
        const { streamed, whole } = await bothRenderers(lang, theme);
        for (let n = 0; n <= source.length; n++) {
          const prefix = source.slice(0, n);
          expect(streamed(prefix), `${theme} @${n}`).toBe(whole(prefix));
        }
      }
    },
  );

  test("CR and CRLF endings, including a trailing lone CR, stay identical", async () => {
    const { streamed, whole } = await bothRenderers("typescript", "pierre-dark");
    const source = "/* a\r\nb */\r\nconst n = 1;\r\n";
    for (let n = 0; n <= source.length; n++) {
      expect(streamed(source.slice(0, n))).toBe(whole(source.slice(0, n)));
    }
  });

  test.each(PLAIN_LANGS)("%s output matches a plain render", async (lang) => {
    const { streamed, whole } = await bothRenderers(lang, "pierre-dark");
    for (const text of ["one\ntwo", "\u001b[31mred\nmore", "\n"]) {
      expect(streamed(text)).toBe(whole(text));
    }
  });

  test("editing an earlier line, shrinking, or emptying the text restarts cleanly", async () => {
    const { streamed, whole } = await bothRenderers("typescript", "pierre-dark");
    const timeline = [
      "/* open\nstill\n",
      "/* open\nstill\n*/\nconst a = 1;",
      "const b = 2;\nconst a = 1;",
      "const b = 2;\nconst a = 10;",
      "const b = 2;\n",
      "",
      "\n\n\nconst c = true;\n",
    ];
    for (const text of timeline) expect(streamed(text)).toBe(whole(text));
  });
});
