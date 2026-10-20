// 20-blobs: the Blobs sidebar roster. With no blobs yet it is the tasteful empty state; with blobs, Kora (the Chief)
// is always the first row.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { spec } from "../lib/harness.mjs";

const STACK = Number(process.env.KORA_QA_BLOBS_STACK ?? 2);

const { stack } = createRequire(import.meta.url)("../../stacks/env.cjs");

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "the roster shows the empty state or Kora first, never a broken list",
    async ({ page, open, sleep, expect, inkCheck, covered }) => {
      await open("/blobs", { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
      await sleep(1500);
      const rows = page.locator("[data-blobs-roster] [data-blob-id]");
      const count = await rows.count();
      if (count === 0) {
        await page.locator("[data-blobs-empty]").waitFor({ timeout: 10_000 });
        covered("Blobs › roster empty state");
      } else {
        expect.equal(await rows.first().getAttribute("data-blob-chief"), "true");
        covered("Blobs › Kora is the first row");
      }
      const cold = (await inkCheck({ root: "[data-slot='sidebar']" })).filter(
        (h) => h.kind === "cold",
      );
      if (cold.length) throw new Error(`cold colours in the roster: ${JSON.stringify(cold)}`);
    },
    { control: "Blobs › roster", severity: "broken" },
  );

  t.test(
    "a blob created in the editor appears in the roster and gets its folder",
    async ({ page, open, sleep, expect, covered }) => {
      const name = `Qatest${Date.now().toString(36).slice(-4)}`;
      await open("/blobs", { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
      await page.locator("[data-new-blob], [data-blobs-empty] button").first().click();
      await page.locator("[data-blob-editor]").waitFor();
      await page.getByLabel("Name", { exact: true }).fill(name);
      // The isolated stack has no signed-in engine, so pin one: creating must not depend on "Best installed".
      await page.locator('[data-editor-section="model"]').click();
      await page.locator('[data-model-mode="pick"]').click();
      await page.locator("[data-editor-save]").click();
      const row = page.locator(`[data-blob-id] [data-blob-row][aria-label^="${name}"]`);
      // No error is acceptable: the blob must land in the roster.
      await row.first().waitFor({ timeout: 20_000 });
      await sleep(300);
      expect.equal(await row.count(), 1, "the new blob should have one row");
      const folder = join(stack(STACK).base, "Blobs", name);
      for (const sub of ["files", "outputs", "scratch", "downloads"])
        expect.ok(existsSync(join(folder, sub)), `${folder}/${sub} should exist on disk`);
      covered("Blobs › create → roster row + folder on disk");
    },
    { control: "Blobs › create blob", severity: "broken" },
  );
});
