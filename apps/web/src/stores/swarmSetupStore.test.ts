import { describe, expect, it } from "vite-plus/test";

import { closeSwarmSetup, openSwarmQuickSetup, useSwarmSetupStore } from "./swarmSetupStore";

describe("swarm setup store", () => {
  it("closing flips only `open`, so the dialog keeps its content while it animates out", () => {
    openSwarmQuickSetup();
    closeSwarmSetup();
    expect(useSwarmSetupStore.getState()).toMatchObject({
      open: false,
      variant: "quick",
      step: "intro",
    });
  });
});
