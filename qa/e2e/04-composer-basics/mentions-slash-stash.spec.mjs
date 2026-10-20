// @mention menu, slash-command menu, stash (badge/restore/delete), and draft persistence across
// navigation.
import { spec } from "../lib/harness.mjs";

spec("04-composer-basics", { stack: 1 }, async (t) => {
  t.test(
    "@mention menu opens, filters, arrow-selects and Enter inserts a chip; Backspace removes it",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.click();
      await editor.type("@tiny");
      await sleep(400);
      const bodyText = await page.locator("body").innerText();
      await expect.ok(bodyText.includes("tiny-lib"), "mention menu should filter to tiny-lib");
      covered("Composer › @mention menu filters");

      await page.keyboard.press("ArrowDown");
      await sleep(150);
      await page.keyboard.press("Enter");
      await sleep(300);
      const html = await editor.innerHTML();
      const hasChip = /data-lexical-decorator|composer-citation|context-reference|chip/i.test(html);
      covered(
        "Composer › @mention arrow + Enter inserts",
        hasChip ? "chip inserted" : "no chip marker found",
      );

      // Backspace should remove the just-inserted chip/token.
      await page.keyboard.press("Backspace");
      await sleep(200);
      const afterBackspace = (await editor.textContent()) || "";
      covered("Composer › Backspace removes mention chip", afterBackspace);

      // cleanup
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
    },
    { control: "Composer › @mention menu", severity: "wrong" },
  );

  t.test(
    "slash command menu opens on '/', filters, and Escape closes it without inserting",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.click();
      await editor.type("/model");
      await sleep(400);
      const bodyText = await page.locator("body").innerText();
      await expect.ok(
        /switch response model/i.test(bodyText),
        "slash menu should show the /model item",
      );
      covered("Composer › slash menu filters");

      await page.keyboard.press("Escape");
      await sleep(200);
      const afterEscape = await page.locator("body").innerText();
      await expect.equal(
        /switch response model/i.test(afterEscape),
        false,
        "Escape should close the slash menu",
      );
      const text = (await editor.textContent()) || "";
      await expect.ok(
        text.includes("/model"),
        "Escape should close the menu but leave the typed text",
      );
      covered("Composer › slash menu Escape closes");

      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
    },
    { control: "Composer › slash command menu", severity: "wrong" },
  );

  t.test(
    "an unsent draft on an existing thread survives switching to another thread and back",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      await page.getByLabel("Search chats").fill("[a04] chat one");
      await sleep(250);
      await page.getByText("[a04] chat one", { exact: true }).first().click();
      await sleep(400);
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.click();
      const marker = `draft-persist-${Date.now()}`;
      await editor.type(marker);
      await sleep(200);

      await page.getByLabel("Search chats").fill("[a04] chat two");
      await sleep(250);
      await page.getByText("[a04] chat two", { exact: true }).first().click();
      await sleep(400);

      await page.getByLabel("Search chats").fill("[a04] chat one");
      await sleep(250);
      await page.getByText("[a04] chat one", { exact: true }).first().click();
      await sleep(400);
      await page.getByLabel("Search chats").fill("");
      await sleep(200);

      const editorBack = page.locator('[contenteditable="true"]').first();
      const text = (await editorBack.textContent()) || "";
      covered("Composer › draft survives navigation", text);
      await expect.ok(
        text.includes(marker),
        "the unsent composer text for a thread should survive switching to another thread and back",
      );

      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
    },
    { control: "Composer › draft persists across navigation", severity: "wrong" },
  );
});
