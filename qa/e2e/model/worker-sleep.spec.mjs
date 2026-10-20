// Model test (real Claude): a chat lead's worker finishes, falls asleep, its blob dims, its history (answer +
// transcript) opens from the blob, and Wake resumes it.
// Run on a real-model stack with a short sleep:
//   KORA_QA_REAL_MODELS=1 KORA_WORKER_SLEEP_MS=20000 node qa/stacks/stack.cjs up 1 && node qa/e2e/model/worker-sleep.spec.mjs
import { spec } from "../lib/harness.mjs";

const BASE_URL = process.env.KORA_QA_MODEL_URL || "http://localhost:5710";
const composer = (page) => page.locator('[contenteditable="true"]').first();

spec("model", { url: BASE_URL }, async (t) => {
  t.test(
    "a finished worker falls asleep; its blob opens its history; Wake resumes it",
    async ({ page, open, covered, expect, sleep }) => {
      await open("/");
      await page.getByRole("button", { name: "New chat in tiny-lib" }).click();
      await sleep(1000);
      await composer(page).click();
      await page.keyboard.type(
        "Delegate to ONE worker (claude haiku): reply with exactly one word: ok. kora_wait it, then answer with only its word.",
      );
      await page.keyboard.press("Enter");
      await page.locator("[data-worker-picker-approve]").waitFor({ timeout: 180_000 });
      await page.locator("[data-worker-picker-approve]").click();
      covered("model: worker picker approved");

      await page.locator(".swarm-blob[data-pane-id]").first().waitFor({ timeout: 120_000 });
      covered("model: worker blob shown");
      // An asleep worker rests in the dock's folded pile: wait for the pile, then lay it out.
      await page.locator(".swarm-blob-dock__pile").waitFor({ timeout: 360_000 });
      await page.locator(".swarm-blob-dock__pile").click();
      const asleep = page.locator('.swarm-blob[data-state="asleep"]').first();
      await asleep.waitFor({ timeout: 15_000 });
      covered("model: worker blob asleep after idle");

      await asleep.click();
      const history = page.locator("[data-worker-history]").first();
      await history.waitFor({ timeout: 15_000 });
      await page.locator("[data-worker-transcript] li").first().waitFor({ timeout: 15_000 });
      const text = await history.innerText();
      expect.ok(/Asleep/.test(text), "says asleep");
      expect.ok(/Transcript/.test(text), "shows the transcript");
      covered("model: asleep worker history opens from its blob", text.slice(0, 160));

      await page.locator("[data-worker-wake]").first().click();
      await page
        .locator('.swarm-blob[data-pane-id]:not([data-state="asleep"])')
        .first()
        .waitFor({ timeout: 60_000 });
      covered("model: Wake brings the worker back (session resumed)");
    },
    { control: "Workers › sleep, history, wake (real model)", severity: "broken" },
  );
});
