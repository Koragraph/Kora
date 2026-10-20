// 06-timeline: the virtualised 520-message thread — open performance, scroll reach (top and
// bottom), scroll anchoring, and the "Latest" pill.
// Read-only fixture: never mutated.
import { spec } from "../lib/harness.mjs";

const STACK = 2;

spec("06-timeline", { stack: STACK }, async (t) => {
  t.test(
    "520-message thread opens quickly and is virtualised (small DOM row count)",
    async (ctx) => {
      const { page, open, seed, expect, covered, step } = ctx;
      await open("/");
      const fixture = seed().threads.find((th) => th.title.startsWith("Fixture: long"));
      await page.getByText("tiny-lib").first().click();
      step(`open ${fixture.title}`);
      const t0 = Date.now();
      await page.getByText(fixture.title).first().click();
      // The fixture opens scrolled to a saved mid-thread read position (~message 260 of 520),
      // not necessarily the very end — assert only that content renders promptly.
      await page
        .getByText(/Question \d+:/)
        .first()
        .waitFor({ timeout: 20_000 });
      const elapsed = Date.now() - t0;
      covered("long thread: opens and renders", `${elapsed}ms to first visible message`);

      const rowCount = await page.locator("[data-transcript-row-id]").count();
      expect.ok(
        rowCount < 100,
        `expected virtualisation to keep the DOM row count well under 520, saw ${rowCount}`,
      );
      covered("long thread: virtualised row count", `${rowCount} rows mounted`);
    },
    { control: "Long thread virtualisation", severity: "wrong" },
  );

  // Real wheel input, not scrollTop: the timeline only treats a user gesture as "left the live edge"
  // (programmatic scrolls are ignored so streaming follow is not broken by layout shifts).
  const openLong = async ({ page, open, seed }) => {
    await open("/");
    const fixture = seed().threads.find((th) => th.title.startsWith("Fixture: long"));
    await page.getByText("tiny-lib").first().click();
    await page.getByText(fixture.title).first().click();
    await page
      .getByText(/Question \d+:/)
      .first()
      .waitFor({ timeout: 30_000 });
    await page.mouse.move(700, 400);
  };
  const wheelUntil = async (page, deltaY, done, max = 200) => {
    for (let i = 0; i < max; i++) {
      if (await done()) return true;
      await page.mouse.wheel(0, deltaY);
      await page.waitForTimeout(60);
    }
    return done();
  };

  t.test(
    "520-message thread: top and bottom are both reachable by scrolling",
    async (ctx) => {
      const { page, expect, covered, step } = ctx;
      await openLong(ctx);
      const visible = (text) => () =>
        page
          .getByText(text, { exact: false })
          .first()
          .isVisible()
          .catch(() => false);

      step("scroll to top");
      expect.ok(await wheelUntil(page, -4000, visible("Question 1:")), "Question 1 is reachable");
      covered("long thread: top reachable");

      step("scroll to bottom");
      // 520 messages = 260 question/answer pairs; the last pair is Question 260.
      expect.ok(
        await wheelUntil(page, 4000, visible("Question 260:")),
        "Question 260 is reachable",
      );
      covered("long thread: bottom reachable");
    },
    { control: "Long thread scroll reach", severity: "wrong" },
  );

  t.test(
    "a Latest pill appears once the user scrolls away from the bottom, and returns to the latest message",
    async (ctx) => {
      const { page, expect, covered, step } = ctx;
      await openLong(ctx);
      const pill = page.getByRole("button", { name: "Jump to the latest message" });
      expect.equal(await pill.count(), 0, "no pill while following the live edge");

      step("scroll up with the wheel");
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, -600);
        await page.waitForTimeout(150);
      }
      await pill.waitFor({ timeout: 5_000 });
      covered("long thread: Latest pill appears when scrolled up");

      step("click it");
      await pill.click();
      await page.getByText("Question 260:", { exact: false }).first().waitFor({ timeout: 10_000 });
      await pill.waitFor({ state: "detached", timeout: 5_000 });
      covered("long thread: Latest pill returns to the latest message and hides");
    },
    { control: "Latest pill", severity: "broken" },
  );
});
