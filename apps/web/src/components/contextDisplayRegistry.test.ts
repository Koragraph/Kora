import {
  createContextDisplayRegistry,
  contextPresentationDefinition,
  CONTEXT_PRESENTATION_DEFINITIONS,
} from "./contextDisplayRegistry";
import { describe, expect, it } from "vite-plus/test";
import { CONTEXT_CHIP_KINDS } from "@kora/contracts";

describe("contextPresentationRegistry", () => {
  it("uses the explicit fallback for unknown, missing, and mismatched records", () => {
    const registry = createContextDisplayRegistry<string, undefined, string>({
      fallback: (kind) => `fallback:${kind}`,
      handlers: [
        {
          render: () => "rendered",
          canRender: (record) => record === "terminal",
          kind: "terminal",
        },
      ],
    });

    expect(registry.render("terminal", "terminal", undefined)).toBe("rendered");
    expect(registry.render("terminal", "file", undefined)).toBe("fallback:terminal");
    expect(registry.render("terminal", undefined, undefined)).toBe("fallback:terminal");
    expect(registry.render("future-kind", "payload", undefined)).toBe("fallback:future-kind");
  });

  it("rejects a missing handler required by a surface", () => {
    expect(() =>
      createContextDisplayRegistry<string, undefined, string>({
        fallback: () => "fallback",
        requiredKinds: ["terminal", "review-comment"],
        handlers: [{ kind: "terminal", render: () => "terminal" }],
      }),
    ).toThrowError("Missing context presentation handler: review-comment");
  });

  it("rejects duplicate handlers for one surface", () => {
    expect(() =>
      createContextDisplayRegistry<string, undefined, string>({
        fallback: () => "fallback",
        handlers: [
          { kind: "terminal", render: () => "first" },
          { kind: "terminal", render: () => "second" },
        ],
      }),
    ).toThrowError("Duplicate context presentation handler: terminal");
  });
  it("defines presentation capabilities for every known context kind", () => {
    expect([...CONTEXT_PRESENTATION_DEFINITIONS.keys()]).toEqual(CONTEXT_CHIP_KINDS);
    expect(contextPresentationDefinition("terminal").capabilities).toEqual({
      defaultDraftView: "compact",
      expanded: "none",
      details: "popover",
    });
  });
});
