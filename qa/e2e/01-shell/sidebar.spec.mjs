// 01-shell: sidebar collapse (button + ⌘B), resize handle, width persistence and clamps.
import { spec } from "../lib/harness.mjs";

const WIDTH_KEY = "kora:nav-width";
const MIN_WIDTH = 17 * 16; // THREAD_NAV_MIN_WIDTH

spec("01-shell", { stack: 1 }, async (t) => {
  t.test(
    "sidebar collapse button (top-left) toggles the sidebar",
    async ({ page, open, expect, covered }) => {
      await open("/");
      const trigger = page.getByLabel("Toggle main sidebar");
      await trigger.waitFor({ timeout: 10_000 });
      const before = await page.getAttribute('[data-slot="sidebar-wrapper"]', "data-sidebar-state");
      expect.equal(before, "expanded", `expected the sidebar to start expanded, got "${before}"`);

      await trigger.click();
      await page.waitForTimeout(400);
      const collapsed = await page.getAttribute(
        '[data-slot="sidebar-wrapper"]',
        "data-sidebar-state",
      );
      expect.equal(
        collapsed,
        "collapsed",
        "clicking the collapse trigger did not collapse the sidebar",
      );

      await trigger.click();
      await page.waitForTimeout(400);
      const reExpanded = await page.getAttribute(
        '[data-slot="sidebar-wrapper"]',
        "data-sidebar-state",
      );
      expect.equal(
        reExpanded,
        "expanded",
        "clicking the trigger again did not re-expand the sidebar",
      );
      covered("Sidebar collapse button (top-left)");
    },
    { control: "Sidebar collapse button", severity: "broken" },
  );

  t.test(
    "resize handle: drag widens and narrows, and the width persists on reload",
    async ({ page, open, expect, covered }) => {
      await open("/");
      await page.evaluate((k) => localStorage.removeItem(k), WIDTH_KEY);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByLabel("Search chats").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);

      const rail = page.locator('[data-slot="sidebar-rail"]');
      const box = await rail.boundingBox();
      expect.ok(box, "sidebar resize rail not found");

      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 150, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const widened = Number(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY));
      expect.ok(widened > 272, `expected a wider sidebar after dragging right, got ${widened}`);
      covered("Sidebar resize handle: widen");

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByLabel("Search chats").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);
      const afterReload = Number(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY));
      expect.equal(afterReload, widened, "sidebar width did not persist across reload");
      covered("Sidebar resize width persists on reload");

      const rail2 = page.locator('[data-slot="sidebar-rail"]');
      const box2 = await rail2.boundingBox();
      await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
      await page.mouse.down();
      await page.mouse.move(box2.x - 250, box2.y + box2.height / 2, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const narrowed = Number(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY));
      expect.ok(
        narrowed < widened,
        `expected a narrower sidebar after dragging left, got ${narrowed}`,
      );
      covered("Sidebar resize handle: narrow");

      // Restore default so this spec is rerunnable and doesn't leak state to other tests.
      await page.evaluate((k) => localStorage.removeItem(k), WIDTH_KEY);
    },
    { control: "Sidebar resize handle", severity: "broken" },
  );

  t.test(
    "resize handle clamps at the minimum width",
    async ({ page, open, expect, covered }) => {
      await open("/");
      await page.evaluate((k) => localStorage.removeItem(k), WIDTH_KEY);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByLabel("Search chats").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);

      const rail = page.locator('[data-slot="sidebar-rail"]');
      const box = await rail.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      // Drag far past the minimum to confirm it clamps rather than shrinking further or breaking.
      await page.mouse.move(box.x - 600, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const clamped = Number(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY));
      expect.equal(
        clamped,
        MIN_WIDTH,
        `expected the sidebar to clamp at ${MIN_WIDTH}px, got ${clamped}`,
      );
      covered("Sidebar resize: min-width clamp");

      await page.evaluate((k) => localStorage.removeItem(k), WIDTH_KEY);
    },
    { control: "Sidebar resize min clamp", severity: "wrong" },
  );

  t.test(
    "resize handle clamps at the maximum width for the viewport",
    async ({ page, open, expect, covered }) => {
      await open("/");
      await page.evaluate((k) => localStorage.removeItem(k), WIDTH_KEY);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByLabel("Search chats").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);

      const rail = page.locator('[data-slot="sidebar-rail"]');
      const box = await rail.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      // Viewport is 1440 wide; THREAD_MAIN_CONTENT_MIN_WIDTH (640px) caps the sidebar at 800px.
      await page.mouse.move(box.x + 900, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      const clamped = Number(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY));
      expect.equal(clamped, 1440 - 640, `expected the sidebar to clamp at 800px, got ${clamped}`);
      covered("Sidebar resize: max-width clamp");

      await page.evaluate((k) => localStorage.removeItem(k), WIDTH_KEY);
    },
    { control: "Sidebar resize max clamp", severity: "wrong" },
  );
});
