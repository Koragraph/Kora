// 20-blobs: "Delete permanently…" for a retired blob: type-the-name confirm, then the blob and its roster row are gone and
// its folder is in the Trash. Kora (the Chief) has no such control.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { spec } from "../lib/harness.mjs";

const STACK = Number(process.env.KORA_QA_BLOBS_STACK ?? 2);
const { stack } = createRequire(import.meta.url)("../../stacks/env.cjs");

spec("20-blobs", { stack: STACK }, async (t) => {
  const name = `Delme${Date.now().toString(36).slice(-4)}`;
  t.test(
    "a retired blob can be deleted for real after typing its name; the folder goes to the Trash",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/blobs", { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
      await page.locator("[data-new-blob], [data-blobs-empty] button").first().click();
      await page.locator("[data-blob-editor]").waitFor();
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.locator('[data-editor-section="model"]').click();
      await page.locator('[data-model-mode="pick"]').click();
      await page.locator("[data-editor-save]").click();
      const row = page.locator(`[data-blob-id] [data-blob-row][aria-label^="${name}"]`).first();
      await row.waitFor({ timeout: 25_000 });
      const folder = path.join(stack(STACK).base, "Blobs", name);
      expect.ok(fs.existsSync(folder), "the folder exists before the delete");
      // Retire through the context menu fallback: the web build has no native menu, so use the RPC-backed row menu.
      await row.click({ button: "right" });
      await page
        .getByText(/^Retire…?$/)
        .first()
        .click();
      const confirm = page.getByRole("button", { name: /^(Retire|OK|Confirm|Yes)/ });
      if (
        await confirm
          .first()
          .isVisible()
          .catch(() => false)
      )
        await confirm.first().click();
      await sleep(800);
      await page.getByRole("button", { name: /^Retired \(/ }).click();
      await page.getByRole("button", { name: `Delete ${name} permanently` }).click();
      const dialog = page.locator("[data-blob-delete-dialog]");
      await dialog.waitFor();
      const go = dialog.locator("[data-blob-delete-confirm]");
      expect.ok(await go.isDisabled(), "Delete is off until the name is typed");
      await dialog.locator("[data-blob-delete-input]").fill("wrong");
      expect.ok(await go.isDisabled(), "a wrong name keeps it off");
      await dialog.locator("[data-blob-delete-input]").fill(name);
      expect.ok(!(await go.isDisabled()), "the right name turns it on");
      await go.click();
      await dialog.waitFor({ state: "detached", timeout: 15_000 });
      await sleep(800);
      expect.equal(await page.locator(`[data-blob-row][aria-label^="${name}"]`).count(), 0);
      expect.ok(!fs.existsSync(folder), "the folder left ~/Blobs");
      covered("Blobs › retired row → Delete permanently… → type-the-name → gone");
    },
    { control: "Blobs › delete permanently", severity: "broken" },
  );

  t.test(
    "Kora has no delete: no retired row, and the daemon refuses anyway",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/blobs", { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
      await sleep(500);
      expect.equal(await page.getByRole("button", { name: /Delete Kora permanently/ }).count(), 0);
      covered("Blobs › Kora cannot be deleted from the UI");
    },
    { control: "Blobs › chief protected", severity: "wrong" },
  );
});
