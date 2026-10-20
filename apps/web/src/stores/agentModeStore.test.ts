import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useAgentModeStore } from "./agentModeStore";

describe("agentModeStore · the Team kind the Chat | Team toggle switches to", () => {
  beforeEach(() => {
    useAgentModeStore.setState({ byKey: {}, teamKind: "swarm" });
  });

  it("defaults to Swarm and remembers the last kind picked", () => {
    expect(useAgentModeStore.getInitialState().teamKind).toBe("swarm");
    useAgentModeStore.getState().setTeamKind("orchestrator");
    expect(useAgentModeStore.getState().teamKind).toBe("orchestrator");
  });

  it("an unchanged value keeps the same state object (no re-render)", () => {
    const before = useAgentModeStore.getState();
    before.setTeamKind("swarm");
    expect(useAgentModeStore.getState()).toBe(before);
  });

  it("a draft can be put in either team mode", () => {
    useAgentModeStore.getState().set("draft-1" as never, "orchestrator");
    expect(useAgentModeStore.getState().byKey["draft:draft-1"]).toBe("orchestrator");
  });
});
