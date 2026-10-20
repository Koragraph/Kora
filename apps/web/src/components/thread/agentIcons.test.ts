import { AgentId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { AGENT_ICON_BY_AGENT } from "./agentIconUtils";

describe("engine icons", () => {
  it("Gemini CLI has a mark of its own, so the picker never shows the letters 'GC' as its icon", () => {
    expect(AGENT_ICON_BY_AGENT[AgentId.make("gemini")]).toBeTypeOf("function");
  });
});
