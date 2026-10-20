import { describe, expect, it } from "vite-plus/test";

import { isClaudeResumeCompactionQuestion } from "./claudeResumeCompaction.ts";

describe("claude resume compaction copy", () => {
  // The matcher must recognize every question the formatter can produce.
  // This is the drift guard: rewording one side fails here.

  it.each([
    "Your disk is almost full. Compact old logs first?",
    "Should we resume where we left off?",
  ])("ignores %j", (question) => {
    expect(isClaudeResumeCompactionQuestion(question)).toBe(false);
  });
});
