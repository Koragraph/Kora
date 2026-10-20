import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { parseLenientJson } from "./lenientJson.ts";

const parse = Schema.decodeUnknownSync(parseLenientJson(Schema.Unknown));

describe("lenient JSON", () => {
  it("accepts line comments and trailing commas", () => {
    const text = ["{", '  "on": false, // switched off', '  "ids": ["a", "b",],', "}"].join("\n");
    expect(parse(text)).toEqual({ on: false, ids: ["a", "b"] });
  });

  it("still rejects broken JSON", () => {
    expect(() => parse('["a",, "b"]')).toThrow();
  });

  it("only strips commas that are really trailing, not ones inside strings", () => {
    expect(parse('{"s":"x,}"}')).toEqual({ s: "x,}" });
    expect(parse('["y,]"]')).toEqual(["y,]"]);
    expect(parse('{"n":[3,],}')).toEqual({ n: [3] });
  });
});
