import { describe, expect, it } from "vite-plus/test";

import { parseCliArgs, tokenizeCliArgs } from "./argv.ts";

type Flags = Record<string, string | null>;

const parsed = (flags: Flags = {}, positionals: string[] = []) => ({ flags, positionals });

describe("CLI argument tokenizing", () => {
  it("joins quoted and backslash-escaped spaces into one token", () => {
    const line = String.raw`--set name="Ada Lovelace" --tag big\ cat --set=title='Lead dev'`;
    expect(tokenizeCliArgs(line)).toEqual([
      "--set",
      "name=Ada Lovelace",
      "--tag",
      "big cat",
      "--set=title=Lead dev",
    ]);
  });

  it("keeps backslashes that do not escape anything, quoted or not", () => {
    const line = String.raw`--out dir=D:\work\tmp --out "q=D:\work\tmp"`;
    expect(tokenizeCliArgs(line)).toEqual([
      "--out",
      String.raw`dir=D:\work\tmp`,
      "--out",
      String.raw`q=D:\work\tmp`,
    ]);
  });
});

describe("CLI argument parsing", () => {
  it.each<[string, string | string[]]>([
    ["an empty string", ""],
    ["only spaces", "    "],
    ["an empty argv", []],
    ["a lone --", "--"],
  ])("yields nothing for %s", (_label, input) => {
    expect(parseCliArgs(input)).toEqual(parsed());
  });

  const lines: ReadonlyArray<readonly [string, Flags, string[]?]> = [
    ["--fast", { fast: null }],
    ["--fast --quiet", { fast: null, quiet: null }],
    ["   --fast    --quiet ", { fast: null, quiet: null }],
    ["--level max", { level: "max" }],
    ["--level=max", { level: "max" }],
    ["--fast --level max --trace", { fast: null, level: "max", trace: null }],
    ["--model claude-haiku-4-5", { model: "claude-haiku-4-5" }],
    [
      "--fast --model=claude-haiku-4-5 --trace",
      { fast: null, model: "claude-haiku-4-5", trace: null },
    ],
    ["--system-hint be-brief --fast", { "system-hint": "be-brief", fast: null }],
    [`--system-hint "be brief please" --fast`, { "system-hint": "be brief please", fast: null }],
    ["--fast --spend-cap 12.50", { fast: null, "spend-cap": "12.50" }],
    ["v2.0.1", {}, ["v2.0.1"]],
  ];

  for (const [line, flags, positionals = []] of lines) {
    it(`parses ${JSON.stringify(line)}`, () => {
      expect(parseCliArgs(line)).toEqual(parsed(flags, positionals));
    });
  }

  it("accepts an argv array with positionals between flags", () => {
    expect(parseCliArgs(["v2.0.1", "--dir", "/srv", "--dry-run"])).toEqual(
      parsed({ dir: "/srv", "dry-run": null }, ["v2.0.1"]),
    );
  });

  describe("declared boolean flags", () => {
    const options = { booleanFlags: ["dry-run"] };

    it("never take the following token as their value", () => {
      expect(parseCliArgs(["--dry-run", "v2.0.1"], options)).toEqual(
        parsed({ "dry-run": null }, ["v2.0.1"]),
      );
    });

    it("leave other flags taking a value", () => {
      expect(parseCliArgs(["--dir", "/srv", "v2.0.1"], options)).toEqual(
        parsed({ dir: "/srv" }, ["v2.0.1"]),
      );
    });

    it("combine with value flags and positionals", () => {
      expect(parseCliArgs(["--dry-run", "--dir", "/srv", "v2.0.1"], options)).toEqual(
        parsed({ "dry-run": null, dir: "/srv" }, ["v2.0.1"]),
      );
    });
  });
});
