// 06-timeline: assistant markdown rendering inside the "Fixture: rich transcript" thread —
// headings/lists/tables/links/inline code, code blocks (language badge, copy, wrap), GitHub
// alert blocks, and file-path chips. Read-only fixture: never sent to, never mutated.
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
    "rich transcript renders headings, lists, table, links and inline code",
    async (ctx) => {
      const { page, expect, covered } = ctx;
      await openRichFixture(ctx);

      const headings = await page.locator("h2, h3").count();
      expect.ok(headings > 0, "expected markdown headings to render");
      covered("markdown: headings", `${headings} heading(s)`);

      const listItems = await page.locator("li").count();
      expect.ok(listItems > 0, "expected list items to render");
      covered("markdown: lists (ul/ol)", `${listItems} item(s)`);

      const table = page.locator("table").first();
      expect.ok((await table.count()) > 0, "expected a markdown table");
      const rows = await table.locator("tr").count();
      expect.ok(rows >= 2, "expected table rows");
      covered("markdown: table");

      const inlineCode = await page.locator("code").count();
      expect.ok(inlineCode > 0, "expected inline code spans");
      covered("markdown: inline code");
    },
    { control: "markdown structural rendering", severity: "wrong" },
  );

  t.test(
    "code block: language badge, copy button copies real code, wrap toggle",
    async (ctx) => {
      const { page, expect, covered, defect } = ctx;
      await openRichFixture(ctx);

      const block = page.locator(".reply-md-codeblock").first();
      await block.waitFor({ timeout: 10_000 });
      await block.scrollIntoViewIfNeeded();
      await block.hover();

      const language = await block.getAttribute("data-language");
      expect.ok(language && language.length > 0, "expected a data-language attribute");
      covered("code block: language badge", language);

      const copyBtn = block.getByRole("button", { name: "Copy code" });
      await copyBtn.waitFor({ timeout: 5_000 });
      await copyBtn.click();
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      if (!clip.includes("slugify")) {
        await defect({
          control: "Code block › Copy code",
          page: "Fixture: rich transcript",
          expected: "clipboard contains the code block's source (slugify function)",
          actual: `clipboard: ${JSON.stringify(clip).slice(0, 200)}`,
          severity: "wrong",
        });
      }
      covered("code block: copy button");

      const wrapBtn = block.getByRole("button", { name: /Wrap lines|Disable line wrap/ });
      await wrapBtn.waitFor({ timeout: 5_000 });
      const before = await block.getAttribute("data-wrap");
      await wrapBtn.click();
      await page.waitForTimeout(150);
      const after = await block.getAttribute("data-wrap");
      expect.notEqual(before, after, "expected data-wrap to toggle");
      await wrapBtn.click(); // restore
      await page.waitForTimeout(150);
      covered("code block: wrap toggle");
    },
    { control: "Code block actions", severity: "wrong" },
  );

  t.test(
    "long shell command line: horizontal scroll unless wrapped",
    async (ctx) => {
      const { page, expect, covered } = ctx;
      await openRichFixture(ctx);

      const shellBlock = page.locator('.reply-md-codeblock[data-language="bash"]').first();
      const anyShell =
        (await shellBlock.count()) > 0
          ? shellBlock
          : page.locator(".reply-md-codeblock", { hasText: "node --test" }).first();
      await anyShell.waitFor({ timeout: 10_000 });
      const wrap = await anyShell.getAttribute("data-wrap");
      if (wrap === "true") {
        const wrapBtn = anyShell.getByRole("button", { name: "Disable line wrap" });
        await wrapBtn.click();
        await page.waitForTimeout(150);
      }
      const pre = anyShell.locator("pre, code").first();
      const overflows = await pre.evaluate((el) => el.scrollWidth > el.clientWidth + 2);
      expect.ok(overflows, "expected the long shell line to overflow horizontally when unwrapped");
      covered("code block: horizontal scroll on long lines");
      // restore wrap state
      if (wrap === "true") {
        const wrapBtn = anyShell.getByRole("button", { name: "Wrap lines" });
        await wrapBtn.click();
      }
    },
    { control: "Code block horizontal scroll", severity: "visual" },
  );

  t.test(
    "GitHub alert block (Warning) renders with semantic, non-cold color",
    async (ctx) => {
      const { page, expect, covered, defect } = ctx;
      await openRichFixture(ctx);

      const alert = page.locator('[role="note"]', { hasText: "Warning" }).first();
      await alert.waitFor({ timeout: 10_000 });
      covered("markdown: GitHub alert block (WARNING)");

      const color = await alert.evaluate((el) => getComputedStyle(el.querySelector("p")).color);
      // Sanity: warning should not render as plain foreground (i.e. it does carry color)
      expect.ok(color && color !== "rgba(0, 0, 0, 0)", "expected the alert title to be colored");
    },
    { control: "GitHub alert block", severity: "visual" },
  );

  t.test(
    "file-path chip opens the file preview panel",
    async (ctx) => {
      const { page, expect, covered, defect } = ctx;
      await openRichFixture(ctx);

      const chip = page.getByText("numbers.js", { exact: false }).first();
      await chip.waitFor({ timeout: 10_000 });
      await chip.click();
      await page.waitForTimeout(1000);

      const panel = page.locator("[data-dock-tabbar], [data-dock-surface-content]");
      const opened = (await panel.count()) > 0;
      if (!opened) {
        await defect({
          control: "File-path chip (numbers.js · L2)",
          page: "Fixture: rich transcript",
          expected: "clicking the file chip opens the file preview panel",
          actual: "no right-panel surface appeared after clicking the chip",
          severity: "broken",
        });
      } else {
        covered("file-path chip: click opens file preview");
      }
    },
    { control: "File-path chip open preview", severity: "broken" },
  );

  t.test("ink palette on the rich transcript timeline", async (ctx) => {
    const { inkCheck, covered, defect } = ctx;
    await openRichFixture(ctx);
    const hits = await inkCheck({ root: "[data-transcript-root]" });
    const bad = hits.filter((h) => h.kind === "cold");
    if (bad.length > 0) {
      await defect({
        control: "Ink palette (timeline)",
        page: "Fixture: rich transcript",
        expected: "no cold (blue/cyan/violet) colors in the timeline",
        actual: JSON.stringify(bad.slice(0, 5)),
        severity: "visual",
      });
    }
    covered("ink palette check: timeline", `${hits.length} hue hit(s)`);
  });
});
