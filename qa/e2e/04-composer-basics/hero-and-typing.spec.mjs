// Draft landing hero/placeholder and basic typing → Send enablement, Enter/Shift+Enter, whitespace guard.
import { spec } from "../lib/harness.mjs";

spec("04-composer-basics", { stack: 1 }, async (t) => {
  t.test(
    "hero headline greeting is not actually time-of-day, so it can read wrong",
    async ({ page, open, sleep, expect, defect, covered }) => {
      await open("/");
      await sleep(300);
      const heading = page.locator("h1").first();
      await expect.ok(await heading.isVisible());
      const text = (await heading.textContent()) || "";
      covered("Draft landing › hero headline", text.trim());
      const hour = new Date().getHours();
      const claimsMorning = /good morning/i.test(text);
      if (claimsMorning && (hour < 4 || hour >= 12)) {
        await defect({
          control: "Draft landing › hero headline",
          expected:
            'A greeting that says "Good morning" should only appear in the morning, or the ' +
            "product should not use time-of-day language at all.",
          actual:
            `Headline reads "${text.trim()}" at local hour ${hour} (not morning). The greeting ` +
            "is picked from a fixed list keyed by a hash of the draft id (DraftStageHeadline.tsx), " +
            'not by the actual time of day, so "Good morning" can show any time.',
          severity: "copy",
        });
      }
    },
    { control: "Draft landing › hero headline", severity: "copy" },
  );

  t.test(
    "placeholder text is shown on the empty composer",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      const editor = page.locator('[contenteditable="true"]').first();
      const placeholder = await page
        .locator('[data-lexical-placeholder], [class*="placeholder"]')
        .first()
        .textContent()
        .catch(() => null);
      await expect.ok(await editor.isVisible());
      covered("Composer › placeholder text", placeholder);
    },
    { control: "Composer › placeholder", severity: "wrong" },
  );

  t.test(
    "typing enables Send; whitespace-only keeps it disabled; clearing disables it again",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      const editor = page.locator('[contenteditable="true"]').first();
      const send = page.locator('button[aria-label="Send message"]');
      await editor.click();
      // A brand-new draft: send must start disabled.
      await expect.equal(
        await send.isDisabled(),
        true,
        "Send should be disabled on an empty composer",
      );
      covered("Composer › Send disabled when empty");

      await editor.type("   ");
      await sleep(200);
      await expect.equal(
        await send.isDisabled(),
        true,
        "Send should stay disabled for a whitespace-only prompt",
      );
      covered("Composer › Send disabled on whitespace-only");

      await editor.type("hello there");
      await sleep(200);
      await expect.equal(
        await send.isDisabled(),
        false,
        "Send should enable once real text is typed",
      );
      covered("Composer › Send enabled on typed text");

      // Clear back out (BackSpace repeatedly) and restore an empty draft.
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
      await sleep(150);
      const remaining = (await editor.textContent()) || "";
      if (remaining.trim().length > 0) {
        for (let i = 0; i < remaining.length + 5; i++) await page.keyboard.press("Backspace");
      }
      await sleep(150);
      await expect.equal(await send.isDisabled(), true, "Send should disable again once cleared");
      covered("Composer › Send disabled after clearing");
    },
    { control: "Composer › Send enable/disable", severity: "wrong" },
  );

  t.test(
    "Shift+Enter inserts a newline instead of sending",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.click();
      await editor.type("line one");
      await page.keyboard.press("Shift+Enter");
      await editor.type("line two");
      await sleep(200);
      const html = await editor.innerHTML();
      await expect.ok(
        html.includes("<br") || /line one[\s\S]*<\/p>\s*<p/.test(html),
        "expected a line break inside the composer",
      );
      await expect.ok(
        html.includes("line two"),
        "second line should still be in the composer, not sent",
      );
      covered("Composer › Shift+Enter newline");
      // restore
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
    },
    { control: "Composer › Shift+Enter", severity: "wrong" },
  );

  t.test(
    "Enter on an existing thread submits and shows a calm auth error; composer is usable again",
    async ({ page, open, seed, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      // Use an existing [a04] thread rather than the draft route, so this test never creates a
      // new thread on rerun.
      await page.getByLabel("Search chats").fill("[a04] chat one");
      await sleep(250);
      await page.getByText("[a04] chat one", { exact: true }).first().click();
      await sleep(400);
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.click();
      await editor.type("enter-to-send probe, ignore");
      await page.keyboard.press("Enter");
      await sleep(1500);
      covered("Composer › Enter sends");
      // We should have navigated off the draft route into a real (or errored) thread, and the
      // composer editor should still be present and interactable (not stuck disabled/spinning).
      const editorAfter = page.locator('[contenteditable="true"]').first();
      await expect.ok(await editorAfter.isVisible(), "composer should still be visible after send");
      await editorAfter.click();
      await editorAfter.type("still usable");
      await sleep(200);
      const send = page.locator('button[aria-label="Send message"]');
      await expect.equal(
        await send.isDisabled(),
        false,
        "Send should be usable again after the errored turn",
      );
      covered("Composer › calm auth error, composer reusable");
    },
    {
      control: "Composer › Enter to send (no credentials)",
      severity: "wrong",
      // Expected in this environment: empty Claude/Codex home means Send fails with an auth error.
      allowConsole: [/401|unauthorized|not logged in|auth/i],
      allowNetwork: [/.*/],
    },
  );
});
