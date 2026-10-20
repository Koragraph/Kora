// Model tests (light, real Claude via the swarm-e2e daemon on :8798 and its web server on :5798).
// Two real turns: a Chat round trip, and a long turn interrupted with ⌘. from the composer.
// Run: node qa/stacks/model-web.cjs up && node qa/e2e/model/chat-ui.spec.mjs
import { spec } from "../lib/harness.mjs";

const BASE_URL = process.env.KORA_QA_MODEL_URL || "http://localhost:5798";
const composer = (page) => page.locator('[contenteditable="true"]').first();

spec("model", { url: BASE_URL }, async (t) => {
  t.test(
    "chat round trip returns the answer in the timeline",
    async ({ page, open, covered, expect }) => {
      await open("/");
      await composer(page).click();
      await page.keyboard.type("Reply with exactly the single word: pong");
      await page.keyboard.press("Enter");
      covered("model: send from draft (Enter)");
      await page
        .getByText(/^pong\.?$/i)
        .first()
        .waitFor({ timeout: 120_000 });
      covered("model: assistant reply rendered");
      expect.ok(
        /\/[^/]+\/[^/]+$/.test(new URL(page.url()).pathname),
        "the draft became a thread route",
      );
    },
    { control: "Composer › Send (real model)", severity: "broken" },
  );

  t.test(
    "⌘. interrupts a running turn and the composer is usable again",
    async ({ page, open, covered, sleep, expect }) => {
      await open("/");
      await composer(page).click();
      await page.keyboard.type(
        "Write the numbers from 1 to 600, one per line, with no other text.",
      );
      await page.keyboard.press("Enter");
      await page
        .getByText(/^\s*40\s*$/m)
        .first()
        .waitFor({ timeout: 120_000 }); // streaming has started
      const t0 = Date.now();
      await page.getByRole("button", { name: "Stop generation" }).first().click();
      covered("model: Stop generation button");
      // Stopped = no stop control and the composer accepts input again.
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll("button")].some((b) =>
            /stop/i.test(b.getAttribute("aria-label") || ""),
          ),
        null,
        { timeout: 10_000 },
      );
      const ms = Date.now() - t0;
      expect.ok(ms < 5000, `stop took ${ms} ms`);
      await sleep(1500);
      const body = await page.locator("body").innerText();
      expect.ok(!/\n\s*600\s*\n/.test(body), "the turn ran to completion instead of stopping");
      await composer(page).click();
      await page.keyboard.type("still usable");
      expect.match(await composer(page).innerText(), /still usable/);
      covered("model: composer usable after stop");
    },
    { control: "Composer › ⌘. stop (real model)", severity: "broken" },
  );
});
