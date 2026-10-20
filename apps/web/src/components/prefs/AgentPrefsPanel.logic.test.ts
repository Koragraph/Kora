import { describe, expect, it } from "vite-plus/test";

import { isAgentPrefsHostAvailable } from "./AgentPrefsPanel.logic";

describe("agents settings availability", () => {
  it("requires a connected environment with server config for searchable provider settings", () => {
    expect(
      isAgentPrefsHostAvailable({
        connectionPhase: "connected",
        hasDaemonConfig: true,
      }),
    ).toBe(true);
    expect(
      isAgentPrefsHostAvailable({
        connectionPhase: "reconnecting",
        hasDaemonConfig: true,
      }),
    ).toBe(false);
    expect(
      isAgentPrefsHostAvailable({
        connectionPhase: "connected",
        hasDaemonConfig: false,
      }),
    ).toBe(false);
  });
});
