// 20-blobs: a blob thread's permission posture comes from the blob, the composer menu shows it, and an explicit pick
// in that menu is the only way to change it. (Live QA #1: every blob thread ran "Full access" whatever the profile said.)
// No tokens are spent: the isolated stack has no signed-in engine.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { spec } from "../lib/harness.mjs";

const STACK = Number(process.env.KORA_QA_BLOBS_STACK ?? 2);
const { stack } = createRequire(import.meta.url)("../../stacks/env.cjs");

async function hire(page, open, name, permission) {
  await open("/blobs", { wait: false });
  await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
  await page.locator("[data-new-blob], [data-blobs-empty] button").first().click();
  await page.locator("[data-blob-editor]").waitFor();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.locator('[data-editor-section="model"]').click();
  await page.locator('[data-model-mode="pick"]').click();
  await page.locator('[data-editor-section="permissions"]').click();
  await page.locator(`[data-permission="${permission}"]`).click();
  await page.locator("[data-editor-save]").click();
  await page
    .locator(`[data-blob-id] [data-blob-row][aria-label^="${name}"]`)
    .first()
    .waitFor({ timeout: 25_000 });
}

/** The composer's model picker (the one with a Permissions group): opens it and reads the selected mode. */
async function composerPermission(page, pick) {
  const triggers = page.locator("[data-agent-model-picker]");
  const n = await triggers.count();
  for (let i = n - 1; i >= 0; i -= 1) {
    await triggers.nth(i).click();
    const group = page.locator('[data-testid="model-picker-permissions"]');
    if (await group.isVisible().catch(() => false)) {
      if (pick) await group.locator(`[data-permission-mode="${pick}"]`).click();
      else {
        const selected = await group
          .locator('[data-permission-mode][aria-checked="true"]')
          .getAttribute("data-permission-mode");
        await page.keyboard.press("Escape");
        return selected;
      }
      return pick;
    }
    await page.keyboard.press("Escape");
  }
  throw new Error("no composer permission menu found");
}

function threadHeads(n) {
  const dir = path.join(stack(n).home, "kora-daemon", "threads");
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    : [];
}

spec("20-blobs", { stack: STACK }, async (t) => {
  const stamp = Date.now().toString(36).slice(-4);
  const askName = `Askblob${stamp}`;

  t.test(
    "an Ask blob's composer shows its real posture, not Full access",
    async ({ page, open, sleep, expect, covered }) => {
      await hire(page, open, askName, "ask");
      await page
        .locator(`[data-blob-id] [data-blob-row][aria-label^="${askName}"]`)
        .first()
        .click();
      await page.locator("[data-agent-model-picker]").first().waitFor({ timeout: 30_000 });
      await sleep(800);
      const mode = await composerPermission(page, null);
      expect.equal(mode, "approval-required", "Ask must read as the supervised mode in the menu");
      covered("Blobs › composer permission menu reflects the blob's posture");
    },
    { control: "Blobs › permission posture in composer", severity: "broken" },
  );

  t.test(
    "the thread the daemon creates keeps the blob's posture even though the composer sends its own default",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/blobs", { wait: false });
      await page
        .locator(`[data-blob-id] [data-blob-row][aria-label^="${askName}"]`)
        .first()
        .click();
      const box = page.locator('[contenteditable="true"]').last();
      await box.waitFor({ timeout: 30_000 });
      await box.click();
      await page.keyboard.type("hello, just checking the posture");
      await page.keyboard.press("Enter");
      await sleep(3000); // the isolated stack has no engine: the turn fails, the thread still exists
      const blobId = JSON.parse(
        fs.readFileSync(
          path.join(
            stack(STACK).home,
            "blobs",
            fs.readdirSync(path.join(stack(STACK).home, "blobs")).find((d) => {
              const f = path.join(stack(STACK).home, "blobs", d, "profile.json");
              return fs.existsSync(f) && JSON.parse(fs.readFileSync(f, "utf8")).name === askName;
            }),
            "profile.json",
          ),
          "utf8",
        ),
      ).id;
      const mine = threadHeads(STACK).filter((h) => h.projectId === blobId);
      expect.ok(mine.length > 0, "the blob has a thread on disk");
      for (const h of mine)
        expect.equal(h.runtimeMode, "approval-required", `thread ${h.threadId} must keep Ask`);
      covered("Blobs › new thread starts in the blob's posture on disk");
    },
    { control: "Blobs › thread posture enforced by the daemon", severity: "broken" },
  );

  t.test(
    "choosing Full in the thread's permission menu is a deliberate change and sticks",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/blobs", { wait: false });
      await page
        .locator(`[data-blob-id] [data-blob-row][aria-label^="${askName}"]`)
        .first()
        .click();
      await page.locator("[data-agent-model-picker]").first().waitFor({ timeout: 30_000 });
      await sleep(1000);
      await composerPermission(page, "full-access");
      await sleep(1200);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator("[data-agent-model-picker]").first().waitFor({ timeout: 40_000 });
      await sleep(1200);
      const mode = await composerPermission(page, null);
      expect.equal(mode, "full-access", "the explicit pick is shown after a reload");
      covered("Blobs › explicit permission change persists per thread");
    },
    { control: "Blobs › permission menu change", severity: "wrong" },
  );
});
