// Model picker (open by click, search, close by click), the graph/index chip, and a guard that
// Kora has no keyboard shortcuts: the chords that used to open pickers or stop a turn do nothing.
import { spec } from "../lib/harness.mjs";

spec("05-composer-controls", { stack: 1 }, async (t) => {
  t.test(
    "model picker opens by click, search filters, a second click closes it",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await page.locator("[data-prompt-attach]").waitFor({ timeout: 15_000 });
      await sleep(200);
      const trigger = page.locator("[data-agent-model-picker]");
      await trigger.click();
      await sleep(300);
      const search = page.getByPlaceholder("Find a model");
      await expect.ok((await search.count()) > 0, "model picker search box should be visible");
      covered("Composer › model picker opens by click");

      await search.fill("Haiku");
      await sleep(300);
      // The list only: the trigger itself may read "Opus" when that is the selected model.
      const listText = await page.locator("[data-model-picker-content]").last().innerText();
      await expect.ok(listText.includes("Haiku"), "search should keep Haiku");
      await expect.ok(!listText.includes("Opus"), "search should filter out Opus");
      covered("Composer › model picker search filters");
      await search.fill("");
      await sleep(200);

      await trigger.click();
      await sleep(250);
      await expect.equal(await search.count(), 0, "clicking the trigger again closes the picker");
      covered("Composer › model picker closes by click");
    },
    { control: "Composer › model picker (click)", severity: "wrong" },
  );

  t.test(
    "graph chip beside the project name shows the index state",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await page.locator("[data-prompt-attach]").waitFor({ timeout: 15_000 });
      await sleep(300);
      // The chip sits beside the project name in the top bar (a Code thread; the Chat surface has no graph).
      await page.getByRole("button", { name: "New chat in tiny-lib" }).click();
      await sleep(800);
      const chip = page.locator('[data-chat-header-project] [data-testid="graph-status-chip"]');
      await chip.waitFor({ timeout: 10_000 });
      await expect.ok(
        /Not indexed|Index this repo|Indexed|Out of date|Indexing|Finalizing|Incomplete|Folder missing/.test(
          (await chip.textContent()) ?? "",
        ),
        "graph chip should render some indexing state",
      );
      covered("Composer › graph chip state", await chip.first().textContent());
    },
    { control: "Composer › graph chip", severity: "wrong" },
  );

  t.test(
    "former keyboard shortcuts open nothing and leave the composer usable",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await page.locator("[data-prompt-attach]").waitFor({ timeout: 15_000 });
      await sleep(300);
      const mod = process.platform === "darwin" ? "Meta" : "Control";
      const popup = () =>
        page.locator(
          '[role="listbox"], [data-slot="select-popup"], [data-slot="menu-popup"], [role="dialog"], [data-slot="popover-popup"]',
        );
      for (const combo of [
        `${mod}+k`,
        `${mod}+p`,
        `${mod}+Shift+M`,
        `${mod}+Shift+A`,
        `${mod}+Shift+X`,
        `${mod}+Shift+G`,
        `${mod}+Shift+L`,
        `${mod}+.`,
      ]) {
        await page.keyboard.press(combo);
        await sleep(200);
        await expect.equal(await popup().count(), 0, `${combo} should open nothing`);
      }
      covered("Composer › no keyboard shortcuts");
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.click();
      await editor.type("ok");
      await sleep(150);
      await expect.ok(
        ((await editor.textContent()) || "").includes("ok"),
        "composer should still be usable",
      );
    },
    { control: "Composer › no keyboard shortcuts", severity: "wrong" },
  );
});
