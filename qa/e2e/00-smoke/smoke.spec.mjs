// Smoke: the app shell loads on the stack, the seeded threads list, and a thread opens.
import path from "node:path";
import { spec, QA_ROOT, ROUND } from "../lib/harness.mjs";

const STACK = Number(process.env.KORA_QA_STACK || 1);

spec("00-smoke", { stack: STACK }, async (t) => {
  t.test(
    "app shell loads and lists seeded threads",
    async ({ page, open, seed, expect, covered }) => {
      await open("/");
      const s = seed();
      const fixture = s.threads.find((x) => x.title.startsWith("Fixture: rich"));
      await page.getByText("tiny-lib").first().click();
      await page.getByText(fixture.title).first().waitFor({ timeout: 20_000 });
      covered("sidebar: seeded thread visible");
      await page.screenshot({ path: path.join(QA_ROOT, "runs", ROUND, "00-smoke", "home.png") });
      const buttons = await page.$$eval("button", (bs) =>
        bs
          .map((b) => b.getAttribute("aria-label") || b.textContent.trim())
          .filter(Boolean)
          .slice(0, 80),
      );
      console.log("buttons:", JSON.stringify(buttons));
      expect.ok(buttons.length > 3);
    },
  );

  t.test(
    "a seeded thread opens and renders its transcript",
    async ({ page, open, seed, covered }) => {
      await open("/");
      const s = seed();
      const fixture = s.threads.find((x) => x.title.startsWith("Fixture: rich"));
      await page.getByText("tiny-lib").first().click();
      await page.getByText(fixture.title).first().click();
      await page.getByText("Summary").first().waitFor({ timeout: 20_000 });
      covered("thread: open rich fixture");
      console.log("url:", page.url());
      await page.screenshot({ path: path.join(QA_ROOT, "runs", ROUND, "00-smoke", "thread.png") });
    },
  );

  t.test("ink palette on home", async ({ open, inkCheck }) => {
    await open("/");
    const hits = await inkCheck();
    console.log("stone hits:", JSON.stringify(hits.slice(0, 20), null, 1));
  });
});
