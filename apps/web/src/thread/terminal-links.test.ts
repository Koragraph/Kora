import { describe, expect, it } from "vite-plus/test";

import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isAbsolutePath,
  isTerminalLinkActivation,
  isTerminalUrl,
  resolvePathLinkTarget,
  type TerminalBufferLineLike,
} from "./terminal-links";

/** The links found in `line`, as `kind:text@start`. */
const links = (line: string) =>
  extractTerminalLinks(line).map((l) => `${l.kind}:${l.text}@${l.start}`);

describe("finding links in a terminal line", () => {
  it.each([
    [
      "a URL and a relative path with a line number",
      "see https://kora.dev/docs and src/app/main.ts:42",
      ["url:https://kora.dev/docs@4", "path:src/app/main.ts:42@30"],
    ],
    ["any scheme casing", "open HTTPS://kora.dev/a", ["url:HTTPS://kora.dev/a@5"]],
    [
      "a Windows path with forward slashes",
      "at C:/work/app/x.ts:7 now",
      ["path:C:/work/app/x.ts:7@3"],
    ],
    [
      "home, dot and root forms",
      "~/notes.md ./a/b.ts /etc/hosts",
      ["path:~/notes.md@0", "path:./a/b.ts@11", "path:/etc/hosts@20"],
    ],
  ])("%s", (_, line, expected) => {
    expect(links(line)).toEqual(expected);
  });

  it("trims sentence punctuation and unmatched closing brackets, keeping matched ones", () => {
    expect(links("(https://kora.dev/docs), ./src/a.ts:12.")).toEqual([
      "url:https://kora.dev/docs@1",
      "path:./src/a.ts:12@25",
    ]);
    expect(links("(C:/tmp/x.ts).")).toEqual(["path:C:/tmp/x.ts@1"]);
    expect(links("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual([
      "url:https://en.wikipedia.org/wiki/Foo_(bar)@0",
    ]);
  });

  it("never reports a path inside a URL, and gives each link's end offset", () => {
    const [url] = extractTerminalLinks("go https://kora.dev/a/b.ts now");
    expect(url).toEqual({ kind: "url", text: "https://kora.dev/a/b.ts", start: 3, end: 26 });
    expect(extractTerminalLinks("go https://kora.dev/a/b.ts now")).toHaveLength(1);
  });
});

it.each([
  ["HTTPS://kora.dev", true],
  ["http://localhost:3000", true],
  ["src/a.ts", false],
  ["httpsdocs/readme.md", false],
])("isTerminalUrl(%j) is %s", (text, expected) => {
  expect(isTerminalUrl(text)).toBe(expected);
});

it.each([
  ["/usr/bin", true],
  ["C:\\x", true],
  ["d:/x", true],
  ["\\\\server\\share", true],
  ["src/x", false],
  ["~/x", false],
])("isAbsolutePath(%j) is %s", (text, expected) => {
  expect(isAbsolutePath(text)).toBe(expected);
});

describe("which click opens a link", () => {
  it.each([
    ["MacIntel", { metaKey: true, ctrlKey: false }, true],
    ["MacIntel", { metaKey: false, ctrlKey: true }, false],
    ["Win32", { metaKey: false, ctrlKey: true }, true],
    ["Linux x86_64", { metaKey: true, ctrlKey: false }, false],
    ["MacIntel", { metaKey: true, ctrlKey: true }, false],
    ["", { metaKey: true, ctrlKey: true }, false],
  ])("on %j with %j: %s", (platform, keys, expected) => {
    expect(isTerminalLinkActivation(keys, platform)).toBe(expected);
  });
});

describe("where a clicked path points", () => {
  it.each([
    [
      "an absolute path stays as it is",
      "/home/sam/app/x.ts:3",
      "/home/sam/app",
      "/home/sam/app/x.ts:3",
    ],
    [
      "so does a Windows one",
      "C:/Users/sam/app/x.ts:3",
      "C:\\Users\\sam\\app",
      "C:/Users/sam/app/x.ts:3",
    ],
    [
      "a relative path joins the cwd, position kept",
      "src/x.ts:42:7",
      "/home/sam/app/",
      "/home/sam/app/src/x.ts:42:7",
    ],
    [
      "on Windows with backslashes",
      "src/x.ts",
      "C:\\Users\\sam\\app",
      "C:\\Users\\sam\\app\\src\\x.ts",
    ],
    ["~ is the home the cwd is under", "~/notes.md", "/Users/sam/work/app", "/Users/sam/notes.md"],
    ["~ stays when no home can be told", "~/notes.md", "/srv/app", "~/notes.md"],
  ])("%s", (_, path, cwd, expected) => {
    expect(resolvePathLinkTarget(path, cwd)).toBe(expected);
  });
});

describe("a long line the terminal wrapped onto several rows", () => {
  /** Buffer rows; a row starting with ">" continues the one above (the `>` is not part of the text). */
  const buffer = (...rows: string[]) => {
    const lines: TerminalBufferLineLike[] = rows.map((row) => {
      const text = row.replace(/^>/, "");
      return {
        isWrapped: row.startsWith(">"),
        translateToString: (trim = false) => (trim ? text.trimEnd() : text),
      };
    });
    return (index: number) => lines[index];
  };

  it("is read back whole from any of its rows, with each row's span", () => {
    const rows = buffer("$ make", "see https://kora.dev/a", ">/b?x=1", "done");
    const whole = collectWrappedTerminalLinkLine(2, rows);
    expect(whole).toEqual({
      text: "see https://kora.dev/a/b?x=1",
      segments: [
        { bufferLineNumber: 2, text: "see https://kora.dev/a", startIndex: 0, endIndex: 22 },
        { bufferLineNumber: 3, text: "/b?x=1", startIndex: 22, endIndex: 28 },
      ],
    });
    expect(collectWrappedTerminalLinkLine(3, rows)).toEqual(whole);
  });

  it("keeps the trailing spaces of a row that continues, so link offsets line up", () => {
    const whole = collectWrappedTerminalLinkLine(1, buffer("run:   ", ">https://kora.dev/x"));
    expect(whole?.text).toBe("run:   https://kora.dev/x");
    expect(links(whole!.text)).toEqual(["url:https://kora.dev/x@7"]);
  });

  it("is nothing for a row that is not there", () => {
    expect(collectWrappedTerminalLinkLine(5, buffer("only one"))).toBeNull();
  });
});
