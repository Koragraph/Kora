// F1 / F2 (swarm QA 2026-10-02): with a dock panel open at 1280 px the chat column is ~440 px; the composer must keep
// Swarm on screen, icon-only, instead of scrolling it out of the hidden-scrollbar row. Council is not built, so it is
// not in the box at all (night 2026-10-04, A10). A draft's side-panel tabs already hold the Workers slot, so it does
// not shift under the pointer when the draft becomes a thread.
import { spec, threadIdByTitle, openDockGroup, openDockPanel } from "../lib/harness.mjs";

const HOST = "kora-local";
const THREAD = threadIdByTitle(1, "[a05] chat one");

const visibleInFooter = (page, sel) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const row = document.querySelector("[data-prompt-controls=left]");
    if (!el || !row) return false;
    const a = el.getBoundingClientRect();
    const b = row.getBoundingClientRect();
    return a.width > 0 && a.left >= b.left - 1 && a.right <= b.right + 1;
  }, sel);

spec("05-composer-controls", { stack: 1 }, async (t) => {
  t.test(
    "a dock panel open at 1280 px keeps Swarm reachable (icon only)",
    async ({ page, open, sleep, expect, covered }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await open(`/${HOST}/${THREAD}`);
      await page.locator("[data-prompt-swarm]").waitFor({ timeout: 20_000 });
      expect.ok(await visibleInFooter(page, "[data-prompt-swarm]"), "Swarm visible at full width");
      await openDockGroup(page, "files");
      await sleep(800);
      const form = await page.evaluate(() => document.querySelector("form")?.clientWidth ?? 0);
      expect.ok(form < 620, `chat column is narrow with the panel open (form ${form}px)`);
      expect.ok(await visibleInFooter(page, "[data-prompt-swarm]"), "Swarm still fully visible");
      expect.equal(
        await page.locator("[data-prompt-swarm]").getAttribute("aria-label"),
        "Stretch",
        "icon-only Stretch keeps its accessible name",
      );
      covered("Composer › narrow width keeps Swarm (icon only)");
    },
    { control: "Composer › narrow width (dock panel open)", severity: "broken" },
  );

  t.test(
    "Council is not in the composer until it is built",
    async ({ page, open, expect, covered }) => {
      await open(`/${HOST}/${THREAD}`);
      await page.locator("[data-prompt-swarm]").waitFor({ timeout: 20_000 });
      expect.equal(await page.locator("[data-prompt-council]").count(), 0, "no Council button");
      covered("Composer › no Council placeholder");
    },
    { control: "Composer › Council hidden", severity: "wrong" },
  );

  t.test(
    "a draft's side-panel tabs already have the Workers slot (no shift when it becomes a thread)",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await page.locator("[data-dock-toggle]").waitFor({ timeout: 20_000 });
      await openDockPanel(page);
      await sleep(500);
      const groups = await page
        .locator("[data-dock-tabs] [data-dock-group]")
        .evaluateAll((els) =>
          els.map((e) => `${e.dataset.dockGroup}:${e.getAttribute("aria-disabled") ?? "-"}`),
        );
      expect.equal(groups[0], "workers:true", `tab order ${groups.join(",")}`);
      covered("Dock tabs › stable slots draft → thread");
    },
    { control: "Dock tabs › draft", severity: "wrong" },
  );
});
