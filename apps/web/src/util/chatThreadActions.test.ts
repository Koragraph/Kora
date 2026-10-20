import {
  resolveNewThreadModelPickOverride,
  resolveNewDraftStartFromOrigin,
  hasExplicitPromptModelPick,
} from "./chatThreadActions";
import { describe, expect, it } from "vite-plus/test";
import { AgentProfileId, type ModelPick } from "@kora/contracts";

const PROJECT_DEFAULT_SELECTION: ModelPick = {
  model: "project-default",
  instanceId: AgentProfileId.make("codex"),
};
const CARRIED_SELECTION: ModelPick = {
  model: "carried-model",
  instanceId: AgentProfileId.make("codex"),
};

describe("chatThreadActions", () => {
  it("only applies the start-from-origin default to new worktree drafts", () => {
    expect(
      resolveNewDraftStartFromOrigin({
        newWorktreesStartFromOrigin: true,
        envMode: "worktree",
      }),
    ).toBe(true);
    expect(
      resolveNewDraftStartFromOrigin({
        newWorktreesStartFromOrigin: true,
        envMode: "local",
      }),
    ).toBe(false);
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelPickOverride({
        destinationDraftId: "draft-b",
        carrySourceDraftId: "draft-a",
        carrySelection: CARRIED_SELECTION,
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });

  it("still carries models between different threads when the project has no default", () => {
    expect(
      resolveNewThreadModelPickOverride({
        destinationDraftId: "draft-b",
        carrySourceDraftId: "draft-a",
        carrySelection: CARRIED_SELECTION,
        projectDefaultSelection: null,
      }),
    ).toEqual(CARRIED_SELECTION);
  });

  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelPickOverride({
        destinationDraftId: "draft-a",
        carrySourceDraftId: "draft-a",
        carrySelection: CARRIED_SELECTION,
        projectDefaultSelection: null,
      }),
    ).toBeNull();
  });
  it("only treats an active stored selection marked explicit as an explicit pick", () => {
    const draft = {
      modelSelectionExplicit: true,
      modelSelectionByProvider: {
        [PROJECT_DEFAULT_SELECTION.instanceId]: PROJECT_DEFAULT_SELECTION,
      },
      activeProvider: PROJECT_DEFAULT_SELECTION.instanceId,
    };

    expect(hasExplicitPromptModelPick(draft)).toBe(true);
    expect(hasExplicitPromptModelPick({ ...draft, modelSelectionExplicit: false })).toBe(false);
    expect(hasExplicitPromptModelPick({ ...draft, activeProvider: null })).toBe(false);
  });
});
