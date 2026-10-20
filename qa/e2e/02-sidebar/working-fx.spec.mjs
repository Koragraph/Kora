// The sidebar's "working" mark (ThreadNav `WorkingFx`, `.nav-working-fx` in index.css): a running turn draws it over
// the thread's card with the card's own rounded corner, and an idle row draws none.
import { spec, threadIdByTitle } from "../lib/harness.mjs";

const THREAD = threadIdByTitle(1, "[a05] chat one");

spec("02-sidebar", { stack: 1 }, async (t) => {
  t.test(
    "a working thread's sidebar mark follows the card's rounded corner",
    async ({ page, open, sleep, expect, covered }) => {
      await open(`/kora-local/${THREAD}`);
      const composer = page.locator('[contenteditable="true"]').first();
      await composer.waitFor({ state: "visible", timeout: 20_000 });
      await composer.click();
      await page.keyboard.type("[stub:slow 30000] keep the turn running");
      await page.keyboard.press("Enter");
      const mark = page.locator(".nav-working-fx");
      await mark.first().waitFor({ state: "attached", timeout: 15_000 });
      await sleep(300);
      const corners = await mark.first().evaluate((el) => {
        const card = el.parentElement?.querySelector("[data-sidebar='menu-button'], button");
        return {
          mark: getComputedStyle(el).borderTopLeftRadius,
          clips: getComputedStyle(el).overflow,
          card: card ? getComputedStyle(card).borderTopLeftRadius : null,
        };
      });
      expect.ok(corners.mark !== "0px", `the mark is rounded (got ${corners.mark})`);
      expect.equal(corners.mark, corners.card, "the mark's corner matches the card's");
      expect.equal(corners.clips, "hidden", "the mark clips the orbiting light to its own corner");
      expect.equal(await mark.count(), 1, "only the working row carries a mark");
      covered("Sidebar › working thread mark (outline) follows the card corner");

      await page.getByRole("button", { name: /stop/i }).first().click();
      await mark.first().waitFor({ state: "detached", timeout: 15_000 });
      covered("Sidebar › working mark clears when the turn stops");
    },
    {
      control: "Sidebar › working thread mark",
      severity: "wrong",
      expected: "the light runs round the card's rounded outline, not a square box around it",
    },
  );

  t.test(
    "every style in the Settings picker shows a visible mini preview",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/settings/general");
      const trigger = page.getByLabel("Working chats in the sidebar");
      await trigger.waitFor({ state: "visible", timeout: 20_000 });
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      await page.getByRole("option").first().waitFor({ state: "visible" });
      await sleep(300);
      const previews = await page.locator('[role="option"] .nav-working-fx').evaluateAll((els) =>
        els
          .filter((el) => el.dataset.style !== "off")
          .map((el) => {
            // Rail, line and scan: the span is the track the light moves along.
            const track = ["rail", "line", "scan"].includes(el.dataset.style);
            const box = track ? getComputedStyle(el) : getComputedStyle(el, "::before");
            return { style: el.dataset.style, w: parseFloat(box.width), h: parseFloat(box.height) };
          }),
      );
      await page.keyboard.press("Escape");
      expect.equal(previews.length, 8, "every style but Just Kora has a preview");
      for (const p of previews) {
        expect.ok(p.w >= 2 && p.h >= 1.5, `${p.style} preview is drawn (${p.w}×${p.h})`);
      }
      expect.ok(
        previews.find((p) => p.style === "rail").h >= 8,
        "the rail preview is tall enough to see",
      );
      expect.ok(
        previews.find((p) => p.style === "line").w >= 24,
        "the line preview spans most of the swatch",
      );
      covered("Settings › Working threads picker previews");

      await page.emulateMedia({ reducedMotion: "reduce" });
      await trigger.click();
      await page.getByRole("option").first().waitFor({ state: "visible" });
      const still = await page
        .locator('[role="option"] .nav-working-fx')
        .evaluateAll((els) =>
          els.map((el) => `${el.dataset.style}:${getComputedStyle(el, "::before").animationName}`),
        );
      await page.keyboard.press("Escape");
      await page.emulateMedia({ reducedMotion: null });
      expect.equal(
        still.filter((s) => !s.endsWith(":none")).join(" "),
        "",
        "reduced motion stops every style",
      );
      covered("Sidebar › working mark holds still under reduced motion");
    },
    {
      control: "Settings › Working threads in the sidebar",
      severity: "wrong",
      expected: "each option's swatch shows its effect, not an empty box",
    },
  );
});
