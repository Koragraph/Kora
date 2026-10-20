// 20-blobs: the blob editor. A draft lives only while the dialog is open; Cancel throws it away.
import { spec } from "../lib/harness.mjs";
import { loadBlob } from "./blobSeed.mjs";

const STACK = Number(process.env.KORA_QA_BLOBS_STACK ?? 2);

async function openEditor(page) {
  await page.locator("[data-new-blob], [data-blobs-empty] button").first().click();
  await page.locator("[data-blob-editor]").waitFor();
  await page.getByLabel("Name", { exact: true }).waitFor();
}

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "editor sections, suggest-a-name and soul presets work",
    async ({ page, open, sleep, expect, inkCheck, covered }) => {
      await open("/blobs", { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
      await openEditor(page);
      const name = page.getByLabel("Name", { exact: true });
      const first = await name.inputValue();
      expect.ok(first.length > 0, "a new blob starts with a suggested name");
      for (let i = 0; i < 8; i += 1) {
        await page.getByRole("button", { name: "Suggest a name" }).click();
        if ((await name.inputValue()) !== first) break;
      }
      expect.ok((await name.inputValue()) !== first, "Suggest changes the name");
      for (const id of ["soul", "model", "access", "permissions"]) {
        await page.locator(`[data-editor-section="${id}"]`).click();
        await sleep(150);
      }
      await page.locator('[data-editor-section="permissions"]').click();
      expect.equal(
        await page.locator('[data-permission="auto"]').getAttribute("aria-checked"),
        "true",
      );
      await page.locator('[data-editor-section="soul"]').click();
      await page.locator('[data-soul-preset="direct"]').click();
      expect.match(await page.getByLabel("Personality").inputValue(), /brisk/);
      const cold = (await inkCheck({ root: "[data-blob-editor]" })).filter(
        (h) => h.kind === "cold",
      );
      if (cold.length) throw new Error(`cold colours in the editor: ${JSON.stringify(cold)}`);
      covered("Blobs › editor sections, suggest, presets, Ink");
    },
    { control: "Blobs › editor", severity: "wrong" },
  );

  t.test(
    "cancelling discards the draft: reopening starts fresh",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/blobs", { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
      await openEditor(page);
      await page.getByLabel("Name", { exact: true }).fill("Discardme");
      await page.getByLabel("Title", { exact: true }).fill("Nothing");
      await page.getByRole("button", { name: "Cancel" }).click();
      // The web build confirms before dropping edits (a DOM dialog); accept it.
      const confirm = page.getByRole("button", { name: /^(Discard|OK|Confirm|Yes)/ });
      if (
        await confirm
          .first()
          .isVisible()
          .catch(() => false)
      )
        await confirm.first().click();
      await sleep(500);
      expect.equal(await page.locator("[data-blob-editor]").count(), 0);
      await openEditor(page);
      expect.ok((await page.getByLabel("Name", { exact: true }).inputValue()) !== "Discardme");
      expect.equal(await page.getByLabel("Title", { exact: true }).inputValue(), "");
      covered("Blobs › editor draft discarded on cancel");
    },
    { control: "Blobs › editor cancel", severity: "wrong" },
  );

  t.test(
    "Free helpers: on by default in the Permissions section, switched off per blob, and the choice is kept",
    async ({ page, open, sleep, expect, covered }) => {
      const name = `Help${Date.now().toString(36).slice(-4)}`;
      await open("/blobs", { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
      await openEditor(page);
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.locator('[data-editor-section="permissions"]').click();
      const toggle = page.getByRole("switch", { name: "Free helpers" });
      await toggle.waitFor();
      expect.equal(await toggle.getAttribute("aria-checked"), "true", "helpers start on");
      expect.match(await page.locator("[data-helpers-row]").innerText(), /at most two/i);
      await toggle.click();
      expect.equal(await toggle.getAttribute("aria-checked"), "false");
      await page.locator('[data-editor-section="model"]').click();
      await page.locator('[data-model-mode="pick"]').click();
      await page.locator("[data-editor-save]").click();
      await page
        .locator(`[data-blob-id] [data-blob-row][aria-label^="${name}"]`)
        .first()
        .waitFor({ timeout: 25_000 });
      await sleep(1500);
      expect.equal(loadBlob(STACK, name).helpers, false, "the profile on disk says helpers off");
      covered("Blobs › editor Free helpers switch (default on, per blob, persisted)");
    },
    { control: "Blobs › editor free helpers", severity: "wrong" },
  );
});
