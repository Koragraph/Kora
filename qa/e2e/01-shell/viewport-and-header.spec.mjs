// 01-shell: viewport extremes (840x700, 2560x1440), the right panel sheet at 840, header content, and the Ink palette.
import { spec, openDockGroup } from "../lib/harness.mjs";

spec("01-shell", { stack: 1 }, async (t) => {
  t.test(
    "840x700: no horizontal scroll, composer and header are not clipped",
    async ({ page, open, seed, expect, covered }) => {
      await open("/");
      const fixture = seed().threads.find((x) => x.title.startsWith("Fixture: rich"));
      await page.getByText("tiny-lib").first().click();
      await page.getByText(fixture.title).first().click();
      await page.getByText("Summary").first().waitFor({ timeout: 15_000 });

      const hasHscroll = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect.ok(!hasHscroll, "the page has horizontal scroll at 840x700");

      const composerBox = await page.locator('[contenteditable="true"]').first().boundingBox();
      expect.ok(composerBox, "composer not found at 840x700");
      expect.ok(
        composerBox.x >= 0 && composerBox.x + composerBox.width <= 840,
        `composer is clipped at 840x700: ${JSON.stringify(composerBox)}`,
      );

      const headerBox = await page.getByText(fixture.title, { exact: true }).first().boundingBox();
      expect.ok(headerBox, "header title not found at 840x700");
      expect.ok(
        headerBox.x >= 0 && headerBox.x + headerBox.width <= 840,
        `header title is clipped at 840x700: ${JSON.stringify(headerBox)}`,
      );
      covered("840x700 layout: no h-scroll, composer/header not clipped");
    },
    { control: "Window at 840x700", severity: "visual", viewport: { width: 840, height: 700 } },
  );

  t.test(
    "2560x1440: content is centred with a sane max width",
    async ({ page, open, seed, expect, covered }) => {
      await open("/");
      const fixture = seed().threads.find((x) => x.title.startsWith("Fixture: rich"));
      await page.getByText("tiny-lib").first().click();
      await page.getByText(fixture.title).first().click();
      const summaryBox = await page.getByText("Summary", { exact: true }).first().boundingBox();
      const composerBox = await page.locator('[contenteditable="true"]').first().boundingBox();
      expect.ok(summaryBox && composerBox, "content not found at 2560x1440");

      const hasHscroll = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect.ok(!hasHscroll, "the page has horizontal scroll at 2560x1440");

      // The composer column (max-w-3xl, mx-auto) is the layout's reference for "centred"; the
      // transcript column should track the same centre, not run flush to one edge.
      const composerCentre = composerBox.x + composerBox.width / 2;
      const summaryCentre = summaryBox.x + summaryBox.width / 2;
      expect.ok(
        Math.abs(composerCentre - summaryCentre) < 40,
        `transcript is not centred with the composer at 2560x1440: composer centre ${composerCentre}, transcript centre ${summaryCentre}`,
      );
      covered("2560x1440 layout: centred content, no stretched lines");
    },
    { control: "Window at 2560x1440", severity: "visual", viewport: { width: 2560, height: 1440 } },
  );

  t.test(
    "840 wide with the right panel open: an overlay sheet, not a squeezed split",
    async ({ page, open, seed, expect, covered }) => {
      await open("/");
      const fixture = seed().threads.find((x) => x.title.startsWith("Fixture: dirty tree review"));
      await page.getByText("dirty-app").first().click();
      await page.getByText(fixture.title).first().click();
      await page.getByRole("heading", { name: fixture.title }).waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);

      await openDockGroup(page, "files");
      await page.waitForTimeout(1000);
      const popup = page.locator('[data-slot="sheet-popup"]');
      await popup.waitFor({ timeout: 8000 });
      const popupBox = await popup.boundingBox();
      expect.ok(popupBox, "right panel sheet did not open at 840px");
      expect.ok(
        popupBox.x + popupBox.width <= 840 + 1,
        `right panel sheet overflows the 840px viewport: ${JSON.stringify(popupBox)}`,
      );
      const bg = await popup.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect.ok(
        bg !== "rgba(0, 0, 0, 0)",
        "right panel sheet has a transparent background at 840px",
      );
      const hasHscroll = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect.ok(!hasHscroll, "the page has horizontal scroll with the right panel open at 840px");
      covered("840px right panel: overlay sheet");

      await popup.getByRole("button", { name: "Tuck the dock away" }).click();
      await page.waitForTimeout(500);
    },
    { control: "Right panel at 840px", severity: "visual", viewport: { width: 840, height: 700 } },
  );

  t.test(
    "header shows the thread title and the project name",
    async ({ page, open, seed, expect, covered }) => {
      await open("/");
      const fixture = seed().threads.find((x) => x.title.startsWith("Fixture: rich"));
      await page.getByText("tiny-lib").first().click();
      await page.getByText(fixture.title).first().click();
      await page.getByRole("heading", { name: fixture.title }).waitFor({ timeout: 15_000 });
      await page.getByText("tiny-lib", { exact: true }).first().waitFor({ timeout: 5000 });
      covered("Header: thread title + project name");
    },
    { control: "Header title/project", severity: "wrong" },
  );

  t.test(
    "header truncates a very long thread title instead of overflowing",
    async ({ page, open, seed, expect, covered }) => {
      await open("/");
      const fixture = seed().threads.find((x) => x.title.startsWith("Fixture: long thread"));
      await page.getByText("tiny-lib").first().click();
      await page.getByText(fixture.title).first().click();
      const heading = page.getByRole("heading", { name: fixture.title });
      await heading.waitFor({ timeout: 15_000 });
      const overflowsCleanly = await heading.evaluate((el) => {
        const cs = getComputedStyle(el);
        return cs.textOverflow === "ellipsis" && cs.overflow !== "visible";
      });
      expect.ok(
        overflowsCleanly,
        "long thread title heading has no ellipsis/overflow truncation styling",
      );
      const box = await heading.boundingBox();
      // The project name + graph chip sit at the bar's right end, in flow after the title.
      const headerRight = await page.locator("[data-chat-header-project]").first().boundingBox();
      expect.ok(
        !headerRight || box.x + box.width <= headerRight.x + 1,
        "long thread title visually overlaps the project label at the bar's right end",
      );
      covered("Header: long title truncation");
    },
    { control: "Header title truncation", severity: "visual" },
  );

  t.test(
    "the Ink palette has no cold/blue colours on the shell",
    async ({ open, inkCheck, defect, covered }) => {
      await open("/");
      const hits = await inkCheck();
      const cold = hits.filter((h) => h.kind === "cold");
      covered("Ink palette: cold-colour check on shell", `${cold.length} cold hit(s)`);
      for (const hit of cold.slice(0, 5)) {
        await defect({
          control: "Ink palette",
          expected: "no cold (blue/cyan/violet) colours anywhere in the dark Ink UI",
          actual: `${hit.element} has a cold ${hit.prop}: ${hit.value} (${hit.oklch})`,
          severity: "visual",
        });
      }
    },
    { control: "Ink palette: shell", severity: "visual" },
  );
});
