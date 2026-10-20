// Prompt history recall (↑/↓) and paste behaviour (plain text, large text stays inline — Kora has no attachments).
import { spec } from "../lib/harness.mjs";

spec("04-composer-basics", { stack: 1 }, async (t) => {
  t.test(
    "pasting plain text inserts it inline",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.click();
      await page.evaluate(() => navigator.clipboard.writeText("pasted plain text sample"));
      await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
      await sleep(300);
      const text = (await editor.textContent()) || "";
      await expect.ok(
        text.includes("pasted plain text sample"),
        "plain text paste should appear inline",
      );
      covered("Composer › paste plain text");
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
    },
    { control: "Composer › paste plain text", severity: "wrong" },
  );

  t.test(
    "pasting 50 KB of text lands inline in the composer",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.click();
      const big = "line of pasted text ".repeat(2500); // ~50KB, under the per-message input limit
      await page.evaluate((t) => navigator.clipboard.writeText(t), big);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
      await sleep(500);
      const text = (await editor.textContent()) || "";
      covered("Composer › paste 50KB text", `inline length=${text.length}`);
      await expect.ok(
        text.length >= big.trim().length - 10,
        "a large paste under the input limit should land inline in full",
      );
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
    },
    { control: "Composer › large paste lands inline", severity: "wrong" },
  );
});
