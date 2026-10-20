import { describe, expect, it } from "vite-plus/test";
import { looksLikeQuickQuestion } from "./QuickAnswerCard";

describe("looksLikeQuickQuestion (client pre-filter; the daemon parser is the strict one)", () => {
  it("lets the fixed phrasings through", () => {
    for (const t of [
      "who calls runThing?",
      "what breaks if I rename runThing",
      "where is runThing defined",
      "callers of runThing",
      "blast radius of runThing",
      "find runThing",
    ])
      expect(looksLikeQuickQuestion(t), t).toBe(true);
  });
  it("never fires on ordinary messages, slash commands, multi-line or long text", () => {
    for (const t of [
      "",
      "fix the bug in runThing",
      "/compact",
      "who calls runThing\nand also fix it",
      "explain runThing",
      `where is ${"x".repeat(200)}`,
    ])
      expect(looksLikeQuickQuestion(t), t).toBe(false);
  });
});
