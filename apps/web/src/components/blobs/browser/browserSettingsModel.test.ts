import { describe, expect, it } from "vite-plus/test";

import { addLocalHost, parseLocalHost, removeLocalHost } from "./browserSettingsModel";

describe("parseLocalHost", () => {
  it("accepts hosts, ports, wildcards and urls", () => {
    expect(parseLocalHost("localhost")).toBe("localhost");
    expect(parseLocalHost("  LocalHost:5173 ")).toBe("localhost:5173");
    expect(parseLocalHost("http://127.0.0.1:3000/app")).toBe("127.0.0.1:3000");
    expect(parseLocalHost("*.test")).toBe("*.test");
  });
  it("refuses nonsense", () => {
    for (const bad of [
      "",
      "   ",
      "a b",
      "localhost:0",
      "localhost:70000",
      "999.1.1.1",
      "-x.test",
      "http://",
      "@evil",
      "a..b",
    ])
      expect(parseLocalHost(bad), bad).toBeNull();
  });
});

describe("list helpers", () => {
  it("adds once, removes exactly", () => {
    expect(addLocalHost(["localhost"], "LOCALHOST")).toEqual(["localhost"]);
    expect(addLocalHost(["localhost"], "*.test")).toEqual(["localhost", "*.test"]);
    expect(removeLocalHost(["a", "b"], "a")).toEqual(["b"]);
  });
});
