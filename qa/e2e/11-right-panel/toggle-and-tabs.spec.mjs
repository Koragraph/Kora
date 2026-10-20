import { spec, threadIdByTitle, openDockGroup, openDockPanel } from "../lib/harness.mjs";

// hostId is constant for the local daemon across all QA stacks.
const HOST = "kora-local";
const THREAD_ONE = threadIdByTitle(3, "[a11] chat one"); // [a11] chat one (tiny-lib project)
const THREAD_TWO = threadIdByTitle(3, "[a11] chat two"); // [a11] chat two (tiny-lib project)

async function openThread(ctx, threadId) {
  await ctx.open(`/${HOST}/${threadId}`);
  // Chat threads mount lazily; wait for either a transcript message or the composer.
  await ctx.page.waitForFunction(() => !!document.querySelector('[contenteditable="true"]'), null, {
    timeout: 20_000,
  });
  await ctx.sleep(500);
}

const toggle = (page) => page.locator("[data-dock-toggle]");
const tabs = (page) => page.locator("[data-dock-tabs]");
const panelHeader = (page) => page.locator("[data-dock-tabbar]");

// Kora has no keyboard shortcuts: the side panel opens from one toggle in the top bar.
spec("11-right-panel", { stack: 3 }, async (t) => {
  t.test(
    "the top-bar toggle opens the side panel, its tabs switch groups, the toggle hides it",
    async (ctx) => {
      const { page, expect, step, covered } = ctx;
      await openThread(ctx, THREAD_ONE);

      step("one toggle; no rail along the right edge; no titlebar control cluster remains");
      expect.equal(await toggle(page).count(), 1, "one side-panel toggle");
      expect.equal(await page.locator("[data-right-dock-rail]").count(), 0, "no dock rail");
      expect.equal(
        await page.getByRole("button", { name: /Toggle terminal drawer/ }).count(),
        0,
        "no terminal drawer toggle",
      );
      expect.equal(
        await page.getByRole("button", { name: /^Toggle right panel/ }).count(),
        0,
        "no titlebar right-panel toggle",
      );
      expect.equal(await panelHeader(page).count(), 0, "panel starts closed");

      step("the toggle opens the panel; its tabs list the workspace groups");
      await openDockPanel(page);
      for (const group of ["files", "browser", "terminal"]) {
        expect.equal(
          await tabs(page).locator(`[data-dock-group="${group}"]`).count(),
          1,
          `panel has a ${group} tab`,
        );
      }
      expect.equal(
        await toggle(page).getAttribute("aria-pressed"),
        "true",
        "toggle reads as pressed",
      );
      covered("Dock toggle — opens the panel, groups listed");

      step("switch to Files from the panel tabs");
      await openDockGroup(page, "files");
      expect.equal(
        await tabs(page).locator('[data-dock-group="files"][aria-selected="true"]').count(),
        1,
        "the Files tab reads as selected",
      );
      covered("Dock tabs › Files");

      step("click the toggle again to hide the panel");
      await toggle(page).click();
      await ctx.sleep(500);
      expect.equal(
        await panelHeader(page).filter({ visible: true }).count(),
        0,
        "the panel hides again",
      );
      covered("Dock toggle › second click hides the panel");
    },
    {
      control: "Side panel toggle (top bar)",
      severity: "broken",
      expected: "the toggle opens the side panel, its tabs switch groups, a second click hides it",
    },
  );

  t.test(
    "Browser is visibly unavailable in the web build and says why",
    async (ctx) => {
      const { page, expect, step, covered } = ctx;
      await openThread(ctx, THREAD_TWO);
      await openDockPanel(page);
      const browser = tabs(page).locator('[data-dock-group="browser"]');
      expect.equal(
        await browser.getAttribute("aria-disabled"),
        "true",
        "Browser is marked unavailable",
      );

      step("hover it for the reason");
      await browser.hover();
      await page.waitForFunction(() => document.body.innerText.includes("desktop app only"), null, {
        timeout: 3000,
      });

      step("a click does nothing");
      await browser.click({ force: true });
      await ctx.sleep(400);
      expect.equal(
        await page.locator('[data-dock-tabbar][data-dock-group="browser"]').count(),
        0,
        "no browser panel opens",
      );
      covered("Dock tabs › Browser (unavailable, desktop-only)");
    },
    {
      control: "Dock tabs › Browser (web build)",
      severity: "wrong",
      expected: "Browser is dimmed with a desktop-only tooltip and does nothing when clicked",
    },
  );

  t.test(
    "open files list under the Files header and switch on click",
    async (ctx) => {
      const { page, expect, step, covered } = ctx;
      await openThread(ctx, THREAD_TWO);
      await openDockGroup(page, "files");
      const header = page.locator("[data-dock-strip]");
      await page
        .locator('[role="treeitem"]')
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });

      step("open README.md, then package.json, from the tree");
      await page.getByRole("treeitem", { name: "README.md" }).click();
      await header.getByText("README.md", { exact: true }).waitFor({ state: "visible" });
      await page.getByRole("treeitem", { name: "package.json" }).click();
      await header.getByText("package.json", { exact: true }).waitFor({ state: "visible" });
      covered("Dock panel › Files strip lists each open file");

      step("switch back to README.md");
      await header.getByText("README.md", { exact: true }).click();
      await ctx.sleep(300);
      const readmeActive = await header
        .locator('[data-active-tab="true"]')
        .filter({ hasText: "README.md" })
        .count();
      expect.ok(readmeActive > 0, "README.md becomes the shown file");
      covered("Dock panel strip — switch by click");
    },
    {
      control: "Dock panel › Files strip",
      severity: "wrong",
      expected: "each opened file gets a strip item under the Files header; clicking one shows it",
    },
  );

  t.test(
    "a strip item's close button closes only that item",
    async (ctx) => {
      const { page, expect, step, covered } = ctx;
      await openThread(ctx, THREAD_ONE);
      await openDockGroup(page, "files");
      const header = page.locator("[data-dock-strip]");
      await page
        .locator('[role="treeitem"]')
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      const [first, second] = ["README.md", "package.json"];
      await page.getByRole("treeitem", { name: first, exact: true }).click();
      await header.getByText(first, { exact: true }).waitFor({ state: "visible" });
      await page.getByRole("treeitem", { name: second, exact: true }).click();
      await header.getByText(second, { exact: true }).waitFor({ state: "visible" });

      step(`close ${second} from its strip item`);
      await page.getByRole("button", { name: `Close ${second}` }).click();
      await ctx.sleep(300);
      expect.equal(await header.getByText(second, { exact: true }).count(), 0, `${second} is gone`);
      expect.ok(
        (await header.getByText(first, { exact: true }).count()) > 0,
        `${first} stays open`,
      );
      covered("Dock panel strip — close button");
    },
    {
      control: "Dock panel strip close button",
      severity: "broken",
      expected: "closing one open file leaves the rest of the group open",
    },
  );

  t.test(
    "the compact sheet opens from the rail and hides from its own button at 840px",
    async (ctx) => {
      const { page, expect, step, covered, inkCheck } = ctx;
      await openThread(ctx, THREAD_ONE);
      const header = await openDockGroup(page, "files");

      const box = await header.boundingBox();
      const viewport = page.viewportSize();
      expect.ok(box && box.width > 0 && box.height > 0, "panel header has a real layout box");
      expect.ok(
        box && box.x >= 0 && box.x + box.width <= viewport.width + 1,
        "panel header does not overflow the viewport horizontally",
      );
      covered(`Dock panel layout at ${viewport.width}x${viewport.height}`);

      const hits = await inkCheck({ root: "[data-dock-tabbar]" });
      const cold = hits.filter((h) => h.kind === "cold");
      if (cold.length > 0) {
        await ctx.defect({
          control: "Dock panel header colour",
          expected: "neutral Ink greys only, no cold/blue hues",
          actual: JSON.stringify(cold.slice(0, 3)),
          severity: "visual",
        });
      }

      step("hide the sheet with its own button");
      await header.getByRole("button", { name: "Tuck the dock away" }).click();
      await ctx.sleep(500);
      expect.equal(
        await panelHeader(page).filter({ visible: true }).count(),
        0,
        "the sheet closes",
      );
      covered("Dock sheet › Tuck the dock away");
    },
    {
      control: "Dock panel responsive layout (compact sheet)",
      severity: "visual",
      expected: "at 840px the panel opens as a sheet that fits and can be hidden",
      viewport: { width: 840, height: 700 },
    },
  );

  t.test(
    "the panel stays usable at 2560px wide",
    async (ctx) => {
      const { page, expect, covered } = ctx;
      await openThread(ctx, THREAD_ONE);
      const header = await openDockGroup(page, "files");
      const box = await header.boundingBox();
      const viewport = page.viewportSize();
      expect.ok(
        box && box.x + box.width <= viewport.width + 1,
        "panel header does not overflow at a very wide viewport",
      );
      covered(`Dock panel layout at ${viewport.width}x${viewport.height}`);
    },
    {
      control: "Dock panel responsive layout (wide)",
      severity: "visual",
      expected: "no horizontal overflow at 2560px",
      viewport: { width: 2560, height: 1440 },
    },
  );

  t.test(
    "the panel header widens the panel and restores it",
    async (ctx) => {
      const { page, expect, step, covered } = ctx;
      await openThread(ctx, THREAD_ONE);
      await openDockGroup(page, "files");
      const before = await page.locator("[data-web-panel-mode]").first().boundingBox();

      step("Spread over the chat");
      await panelHeader(page).getByRole("button", { name: "Spread over the chat" }).click();
      await ctx.sleep(500);
      const wide = await page.locator("[data-web-panel-mode]").first().boundingBox();
      expect.ok(wide.width > before.width + 100, `panel widened (${before.width} → ${wide.width})`);
      covered("Dock rail › Spread over the chat");

      step("Back to the side");
      await panelHeader(page).getByRole("button", { name: "Back to the side" }).click();
      await ctx.sleep(500);
      const restored = await page.locator("[data-web-panel-mode]").first().boundingBox();
      expect.ok(Math.abs(restored.width - before.width) < 4, "panel back to its width");
      covered("Dock rail › Back to the side");
    },
    {
      control: "Dock rail › widen / restore",
      severity: "wrong",
      expected: "the rail's widen control fills the window with the panel and restore undoes it",
    },
  );

  t.test(
    "the resize handle drags the panel to a new width",
    async (ctx) => {
      const { page, expect, step, covered } = ctx;
      await openThread(ctx, THREAD_ONE);
      await openDockGroup(page, "files");

      const handle = page.locator('[role="separator"][aria-orientation="vertical"]').first();
      await handle.waitFor({ state: "visible" });
      const before = await page.locator("[data-web-panel-mode]").first().boundingBox();

      step("drag the resize handle 120px to the left to widen the panel");
      const handleBox = await handle.boundingBox();
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        handleBox.x + handleBox.width / 2 - 120,
        handleBox.y + handleBox.height / 2,
        { steps: 10 },
      );
      await page.mouse.up();
      await ctx.sleep(300);

      const after = await page.locator("[data-web-panel-mode]").first().boundingBox();
      expect.ok(
        after.width > before.width + 50,
        `panel widened (before ${before.width}, after ${after.width})`,
      );
      covered("Dock panel resize handle — drag");
    },
    {
      control: "Dock panel resize handle",
      severity: "wrong",
      expected: "dragging the left-edge handle resizes the panel",
    },
  );
});
