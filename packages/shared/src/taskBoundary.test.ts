import { describe, expect, it } from "vite-plus/test";
import {
  compactCommandText,
  compactionSaving,
  taskBoundaryVerdict,
  taskTokens,
} from "./taskBoundary.ts";

const recent = [
  "fix the stop button so interruptTurn ends the session in ClaudeDriver",
  "I changed claude-driver.ts: sendTurn now calls interruptTurn before the halt flag is set",
  "ok and the halted state? does clearHalt run on result?",
];
const base = { recent, usedTokens: 117_000, userTurns: 8 };

describe("taskTokens", () => {
  it("keeps identifiers whole and in parts, path segments and long words; drops filler", () => {
    const t = taskTokens(
      "Check sendTurn in src/session/claude-driver.ts and the retry_count please",
    );
    for (const w of [
      "sendturn",
      "send",
      "turn",
      "session",
      "claude",
      "driver",
      "retry_count",
      "retry",
      "count",
    ])
      expect(t.has(w), w).toBe(true);
    expect(t.has("please")).toBe(false);
    expect(t.has("the")).toBe(false);
  });
});

describe("taskBoundaryVerdict", () => {
  it("offers a fresh start for an unrelated prompt in a long thread", () => {
    const v = taskBoundaryVerdict({
      ...base,
      draft: "let's redesign the billing page invoice table with sortable columns",
    });
    expect(v.offer).toBe(true);
    expect(v.savedTokens).toBe(compactionSaving(117_000));
  });
  it("stays quiet when the prompt shares the thread's identifiers", () => {
    expect(
      taskBoundaryVerdict({
        ...base,
        draft: "does interruptTurn also need to clear the halted state in ClaudeDriver?",
      }).offer,
    ).toBe(false);
  });
  it("stays quiet for short threads, small contexts, slash commands, follow-ups and tiny prompts", () => {
    const unrelated = "redesign the billing page invoice table with sortable columns";
    expect(taskBoundaryVerdict({ ...base, usedTokens: 40_000, draft: unrelated }).offer).toBe(
      false,
    );
    expect(taskBoundaryVerdict({ ...base, userTurns: 2, draft: unrelated }).offer).toBe(false);
    expect(taskBoundaryVerdict({ ...base, draft: "/compact" }).offer).toBe(false);
    expect(
      taskBoundaryVerdict({
        ...base,
        draft: "and also redesign the billing page invoice table please",
      }).offer,
    ).toBe(false);
    expect(taskBoundaryVerdict({ ...base, draft: "yes do it" }).offer).toBe(false);
    expect(taskBoundaryVerdict({ ...base, usedTokens: null, draft: unrelated }).offer).toBe(false);
  });
  it("the compact command carries the keep-list", () => {
    expect(compactCommandText()).toMatch(/^\/compact Keep decisions and preferences/);
  });
});
