// Model tests across providers (real CLIs via the swarm-e2e daemon on :8798 and its web server on :5798): a thread
// started on each non-Claude provider from the composer's model picker answers, and the picker then speaks that
// provider's language (no Claude-only effort or permission names). Antigravity is skipped when the stack hides agy.
// Run: node qa/stacks/model-web.cjs up && node qa/e2e/model/providers.spec.mjs
import { spec } from "../lib/harness.mjs";

const BASE_URL = process.env.KORA_QA_MODEL_URL || "http://localhost:5798";
const composer = (page) => page.locator('[contenteditable="true"]').first();
const PROVIDERS = [
  { tab: "codex", model: /GPT-5\.6-Luna/ },
  { tab: "opencode", model: null },
  { tab: "acp-opencode", model: null },
  { tab: "antigravity", model: null },
];

spec("providers", { url: BASE_URL }, async (t) => {
  for (const p of PROVIDERS) {
    t.test(
      `${p.tab}: a new thread answers and the picker shows ${p.tab}'s own controls`,
      async ({ page, open, covered, sleep, expect, skip }) => {
        await open("/");
        await page.locator("[data-agent-model-picker]").first().click();
        const tab = page.locator(`[data-model-picker-agent="${p.tab}"]`).first();
        if (/Unavailable/.test((await tab.getAttribute("aria-label")) || ""))
          return skip?.(`${p.tab} not installed in this stack`);
        await tab.click();
        await sleep(500);
        const content = page.locator("[data-model-picker-content]").last();
        const item = p.model
          ? content.getByText(p.model).first()
          : content.locator('[role="option"], [role="menuitemradio"]').first();
        await item.click();
        await sleep(500);
        if (await content.isVisible().catch(() => false)) await page.keyboard.press("Escape");
        await composer(page).click();
        await page.keyboard.type("Reply with exactly the single word: pong");
        await page.keyboard.press("Enter");
        await page
          .getByText(/^pong\.?$/i)
          .first()
          .waitFor({ timeout: 180_000 });
        covered(`model: ${p.tab} reply rendered`);
        await page.locator("[data-agent-model-picker]").first().click();
        await sleep(600);
        const text = await page.locator("[data-model-picker-content]").last().innerText();
        expect.ok(
          !/Ultrathink|Claude Code’s/.test(text),
          `${p.tab} picker shows Claude-only controls: ${text.replace(/\s+/g, " ").slice(0, 300)}`,
        );
        await page.keyboard.press("Escape");
      },
      { control: `Composer › ${p.tab} (real model)`, severity: "broken" },
    );
  }
});
