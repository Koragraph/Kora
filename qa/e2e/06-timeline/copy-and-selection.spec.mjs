// 06-timeline: message-level copy button and the assistant text-selection toolbar (cite).
// Uses the read-only "Fixture: rich transcript" thread; never mutated.
import { spec } from "../lib/harness.mjs";

const STACK = 2;

async function openRichFixture(ctx) {
  const { page, open, seed, step } = ctx;
  await open("/");
  const fixture = seed().threads.find((t) => t.title.startsWith("Fixture: rich"));
  step(`open ${fixture.title}`);
  await page.getByText("tiny-lib").first().click();
  await page.getByText(fixture.title).first().click();
  await page.getByText("Helper").first().waitFor({ timeout: 20_000 });
  return fixture;
}

spec("06-timeline", { stack: STACK }, async (t) => {
  t.test(
    "message copy button copies the message text",
    async (ctx) => {
      const { page, expect, covered, defect } = ctx;
      await openRichFixture(ctx);

      const userBubble = page.locator('[data-message-role="user"]').first();
      await userBubble.waitFor({ timeout: 10_000 });
      await userBubble.hover();

      // The per-message button is labelled "Copy message" (it used to say "Copy link"); a mislabel would be a defect.
      const mislabeled = userBubble.getByRole("button", { name: "Copy link" });
      const hasCopyLinkLabel = (await mislabeled.count()) > 0;
      if (hasCopyLinkLabel) {
        await defect({
          control: "Message copy button (user bubble)",
          page: "Fixture: rich transcript",
          expected: 'the message-copy button is labelled "Copy message"',
          actual: 'the button is labelled "Copy link" although it copies the message text',
          severity: "copy",
        });
      }
      const copyBtn = userBubble.getByRole("button", { name: /Copy (message|link)/ });
      await copyBtn.click();
      await page.waitForTimeout(400);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      expect.ok(clip.length > 0, "expected the clipboard to contain the copied message text");
      covered("message copy button (user)", hasCopyLinkLabel ? "mislabeled Copy link" : "ok");
    },
    { control: "MessageCopyButton", severity: "copy" },
  );

  t.test(
    "assistant selection toolbar: selecting text shows Cite, and it inserts a citation into the composer",
    async (ctx) => {
      const { page, expect, covered, defect } = ctx;
      await openRichFixture(ctx);

      const target = page.getByText("splits on single spaces only", { exact: false }).first();
      await target.waitFor({ timeout: 10_000 });
      await page.waitForTimeout(750);
      const box = await target.boundingBox();
      expect.ok(box, "expected the target text to have a bounding box");

      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(300);

      const cite = page.getByRole("button", { name: /Cite selection in composer/ });
      const appeared = (await cite.count()) > 0;
      if (!appeared) {
        await defect({
          control: "Assistant selection toolbar",
          page: "Fixture: rich transcript",
          expected: "selecting assistant text shows a floating Cite button",
          actual: "no Cite button appeared after selecting assistant text",
          severity: "broken",
        });
      } else {
        await cite.click();
        await page.waitForTimeout(300);
        const composer = page.locator('[contenteditable="true"]').first();
        const chipInComposer = await composer.locator("*", { hasText: "splits on single" }).count();
        if (chipInComposer === 0) {
          await defect({
            control: "Assistant selection toolbar › Cite",
            page: "Fixture: rich transcript",
            expected: "clicking Cite inserts a citation chip into the composer",
            actual: "no citation content found in the composer after clicking Cite",
            severity: "broken",
          });
        } else {
          covered("assistant selection toolbar: cite inserts into composer");
        }
        // restore composer to empty for a clean rerun
        await composer.click();
        await page.keyboard.press("Meta+A");
        await page.keyboard.press("Backspace");
      }
      covered("assistant selection toolbar: appears on selection", appeared ? "ok" : "MISSING");
    },
    { control: "AssistantSelectionToolbar", severity: "broken" },
  );
});
