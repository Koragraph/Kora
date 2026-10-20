// 20-blobs: the blob you were in is remembered across surface switches and a reload.
import { spec } from "../lib/harness.mjs";

const STACK = Number(process.env.KORA_QA_BLOBS_STACK ?? 2);

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "the selected blob survives a trip to Code and a reload (no reopening on Code)",
    async ({ page, open, sleep, expect, covered }) => {
      const stamp = Date.now().toString(36).slice(-4);
      const name = `Keep${stamp}`;
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
      await row.click();
      await sleep(1500);
      const here = page.url();
      const tabs = page.getByRole("tablist", { name: "Surface" });
      await tabs.getByRole("tab", { name: "Code" }).click();
      await sleep(1000);
      await tabs.getByRole("tab", { name: "Kora" }).click();
      await sleep(2500);
      const header = page.locator("[data-blob-header-identity]");
      await header.waitFor({ timeout: 20_000 });
      expect.match(
        (await header.getAttribute("aria-label")) ?? "",
        new RegExp(`^${name}`),
        "back on the same blob, not Kora",
      );
      void here;
      // A reload on the bare index returns to Blobs, on the same blob.
      await open("/", { wait: false });
      await page.locator("[data-blob-header-identity]").waitFor({ timeout: 40_000 });
      expect.match(
        (await page.locator("[data-blob-header-identity]").getAttribute("aria-label")) ?? "",
        new RegExp(`^${name}`),
      );
      expect.equal(
        await tabs.getByRole("tab", { name: "Kora" }).getAttribute("aria-selected"),
        "true",
      );
      covered("Blobs › selected blob + surface persist across switches and reload");
    },
    { control: "Blobs › selection persistence", severity: "wrong" },
  );
});
