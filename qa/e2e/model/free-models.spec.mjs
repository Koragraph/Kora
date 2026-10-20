// Model test (real OpenCode Zen via the swarm-e2e daemon on :8798 / web :5798): the composer's Free models tab lists
// the live free catalog (not the retired 2026-09 seed), and a thread on a model that is not the first one answers.
// Run: node qa/stacks/model-web.cjs up && node qa/e2e/model/free-models.spec.mjs
import { spec } from "../lib/harness.mjs";

const BASE_URL = process.env.KORA_QA_MODEL_URL || "http://localhost:5798";
const RETIRED = /Grok Code|Kimi K2\.5|Glm 5 ·|Minimax M3|Deepseek V4 Flash|Qwen3\.6 Plus/i;

spec("free-models", { url: BASE_URL }, async (t) => {
  t.test(
    "Free models tab lists the live catalog and a non-default free model answers",
    async ({ page, open, covered, sleep, expect }) => {
      await open("/");
      await page.locator("[data-agent-model-picker]").first().click();
      await page.locator('[data-model-picker-agent="opencode"]').first().click();
      await sleep(600);
      const content = page.locator("[data-model-picker-content]").last();
      const names = (await content.innerText()).split("\n").filter((l) => /· free/.test(l));
      console.log("FREE", JSON.stringify(names));
      expect.ok(names.length >= 3, `only ${names.length} free model(s): ${names.join(", ")}`);
      expect.ok(!names.some((n) => RETIRED.test(n)), `retired models offered: ${names.join(", ")}`);
      covered("model picker: live free catalog");
      await content.getByText(names[1]).first().click();
      await sleep(400);
      if (await content.isVisible().catch(() => false)) await page.keyboard.press("Escape");
      await page.locator('[contenteditable="true"]').first().click();
      await page.keyboard.type("Reply with exactly the single word: pong");
      await page.keyboard.press("Enter");
      await page
        .getByText(/^pong\.?$/i)
        .first()
        .waitFor({ timeout: 180_000 });
      covered(`model: ${names[1]} reply rendered`);
    },
    { control: "Composer › Free models (real model)", severity: "broken" },
  );
});
