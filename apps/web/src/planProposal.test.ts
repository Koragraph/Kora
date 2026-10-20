import { describe, expect, test } from "vite-plus/test";

import {
  buildCollapsedPlanProposalPreviewMarkdown,
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
  buildPlanProposalMarkdownFilename,
  planProposalTitle,
  resolvePlanFollowUpSubmission,
  stripDisplayedPlanMarkdown,
} from "./planProposal";

const PLAN = "## Ship it\n\n- step 1\n";

describe("plan title", () => {
  test("is the first markdown heading, or null", () => {
    expect(planProposalTitle("# Move to RPC\n\nBody")).toBe("Move to RPC");
    expect(planProposalTitle("- only a bullet")).toBeNull();
  });

  test("names the markdown file after the heading, with a generic fallback", () => {
    expect(buildPlanProposalMarkdownFilename("# Move Server To Effect RPC")).toBe(
      "move-server-to-effect-rpc.md",
    );
    expect(buildPlanProposalMarkdownFilename("- only a bullet")).toBe("plan.md");
  });

  test("names the implementation thread, with a generic fallback", () => {
    expect(buildPlanImplementationThreadTitle("# Move to RPC\n\nBody")).toBe(
      "Implement Move to RPC",
    );
    expect(buildPlanImplementationThreadTitle("- only a bullet")).toBe("Implement plan");
  });
});

describe("displayed plan", () => {
  test("the title heading is dropped but other headings stay", () => {
    expect(stripDisplayedPlanMarkdown("# T\n\n## Scope\n\n- a\n")).toBe("## Scope\n\n- a");
  });

  test("a Summary heading right after the title is dropped as well", () => {
    expect(stripDisplayedPlanMarkdown("# T\n\n## Summary\n\n- a\n")).toBe("- a");
  });

  test("the collapsed preview drops the same headings and keeps the following lines", () => {
    expect(
      buildCollapsedPlanProposalPreviewMarkdown("# T\n\n## Summary\n\n- a\n- b", { maxLines: 4 }),
    ).toBe("- a\n- b");
  });

  test("a preview cut short ends with an ellipsis marker", () => {
    expect(buildCollapsedPlanProposalPreviewMarkdown("# T\n\n- a\n- b\n- c", { maxLines: 2 })).toBe(
      "- a\n- b\n\n...",
    );
  });
});

describe("implementation prompt and follow-up", () => {
  test("the prompt is the fixed handoff line followed by the trimmed plan", () => {
    expect(buildPlanImplementationPrompt(PLAN)).toBe(
      "PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1",
    );
  });

  test("typed feedback keeps the thread in plan mode and is sent as written", () => {
    expect(
      resolvePlanFollowUpSubmission({ planMarkdown: PLAN, draftText: "Refine step 2 first" }),
    ).toEqual({
      interactionMode: "plan",
      text: "Refine step 2 first",
    });
  });

  test("an empty or blank draft means 'implement it': default mode with the handoff prompt", () => {
    for (const draftText of ["", "   "]) {
      expect(resolvePlanFollowUpSubmission({ planMarkdown: PLAN, draftText })).toEqual({
        interactionMode: "default",
        text: "PLEASE IMPLEMENT THIS PLAN:\n## Ship it\n\n- step 1",
      });
    }
  });

  test.each(["", "Consider this "])("a context chip counts as feedback, with prose %j", (prose) => {
    const draftText = `${prose}[PR #42](kora-context://v1/review-comment/pr-42)`;
    expect(resolvePlanFollowUpSubmission({ planMarkdown: "# Plan", draftText })).toEqual({
      interactionMode: "plan",
      text: draftText,
    });
  });
});
