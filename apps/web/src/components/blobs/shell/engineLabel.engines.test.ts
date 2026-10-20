import { describe, expect, it } from "vite-plus/test";

import { blobAccessMode } from "./blobPosture";
import { claudeAccountOf, engineLabel } from "./engineLabel";

describe("Phase 7 engines in the blob chrome", () => {
  it("a named Claude account reads as Claude + the account; the default login has none", () => {
    expect(claudeAccountOf("claude-work")).toBe("Work");
    expect(claudeAccountOf("claude-my-team")).toBe("My Team");
    expect(claudeAccountOf("claude")).toBeNull();
    expect(claudeAccountOf("codex")).toBeNull();
    expect(claudeAccountOf("api-groq")).toBeNull();
    expect(engineLabel({ instanceId: "claude-work", model: "sonnet" })).toBe("Claude Sonnet");
  });

  it("ACP agents and API endpoints get a plain name, and their placeholder model is not said aloud", () => {
    expect(engineLabel({ instanceId: "gemini", model: "default" })).toBe("Gemini");
    expect(engineLabel({ instanceId: "api-groq", model: "llama-3.3-70b" })).toBe(
      "Groq · llama-3.3-70b",
    );
    expect(engineLabel({ instanceId: "acp-hermes", model: "default" })).toBe("Hermes");
  });

  it("every non-Claude engine runs the Auto posture the daemon enforces itself", () => {
    expect(blobAccessMode("auto", "claude-work")).toBe("auto");
    expect(blobAccessMode("auto", "api-groq")).toBe("auto-accept-edits");
    expect(blobAccessMode("auto", "gemini")).toBe("auto-accept-edits");
    expect(blobAccessMode("ask", "acp-hermes")).toBe("approval-required");
  });
});
