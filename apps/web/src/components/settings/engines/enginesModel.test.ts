import { describe, expect, it } from "vite-plus/test";

import {
  freeSlug,
  joinArgs,
  parseArgs,
  parseEnv,
  slugify,
  statusLine,
  testLine,
} from "./enginesModel";

describe("slugs", () => {
  it("makes ids", () => {
    expect(slugify("My Server!")).toBe("my-server");
    expect(slugify("  --x--  ")).toBe("x");
    expect(freeSlug("Groq", ["groq"])).toBe("groq-2");
    expect(freeSlug("???", [])).toBe("endpoint");
  });
});

describe("args and env", () => {
  it("round-trips", () => {
    expect(parseArgs('agent stdio --name "a b"')).toEqual(["agent", "stdio", "--name", "a b"]);
    expect(joinArgs(["x", "a b", ""])).toBe('x "a b" ""');
    expect(parseEnv("A=1\nbad\n B = two words ")).toEqual({ A: "1", B: "two words" });
  });
});

describe("testLine", () => {
  it("is calm", () => {
    expect(testLine({ ok: true, message: "ok", modelCount: 12 })).toBe(
      "Connected. 12 models available.",
    );
    expect(testLine({ ok: true, message: "ok", modelCount: 1 })).toBe(
      "Connected. 1 model available.",
    );
    expect(testLine({ ok: false, message: "Groq rejected the API key." })).toBe(
      "Groq rejected the API key.",
    );
  });
});

describe("statusLine for a missing OpenCode", () => {
  it("does not tell anyone to install it", () => {
    const line = statusLine({
      id: "opencode",
      label: "OpenCode",
      available: false,
      reason:
        "`opencode` was not found on this Mac. Install OpenCode, or set its path in Settings > Engines.",
    } as never);
    expect(line).toContain("Kora downloads it for you");
    expect(line).not.toContain("Install OpenCode");
  });
});
