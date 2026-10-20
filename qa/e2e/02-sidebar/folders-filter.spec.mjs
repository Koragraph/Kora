// Sidebar project groups + Projects list + filter box: opening a project from the list (and its persistence), the
// live/all toggle beside a project's name, "Open project", and the filter input (typing/clear/Escape/no-results).
import { spec } from "../lib/harness.mjs";

const TINY_LIB = /^tiny-lib/;

spec("02-sidebar", { stack: 1 }, async (t) => {
  t.test(
    "a project in the Projects list opens its group, stays open across reload, and closes again",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      const row = page
        .getByRole("group", { name: "Projects" })
        .getByRole("button", { name: /^big-repo/ });
      await expect.equal(await row.getAttribute("aria-pressed"), "false");
      await row.click();
      await sleep(200);
      await expect.equal(await row.getAttribute("aria-pressed"), "true");
      await expect.ok(
        await page.getByRole("button", { name: "New chat in this project (big-repo)" }).isVisible(),
      );
      covered("Sidebar › Projects list opens a project");

      await open("/");
      await sleep(400);
      const after = page
        .getByRole("group", { name: "Projects" })
        .getByRole("button", { name: /^big-repo/ });
      await expect.equal(
        await after.getAttribute("aria-pressed"),
        "true",
        "should persist across reload",
      );
      covered("Sidebar › opened project persists on reload");

      // Restore: close it so the spec is idempotent on rerun.
      await after.click();
      await sleep(150);
      await expect.equal(await after.getAttribute("aria-pressed"), "false");
    },
    { control: "Sidebar › Projects list", severity: "wrong" },
  );

  t.test(
    "the toggle beside a project's name shows its older chats, and hides them again",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      const toggle = page.getByRole("button", { name: /^Show all \d+ chats in / }).first();
      if ((await toggle.count()) === 0) {
        covered("Sidebar › project toggle", "no project has older chats in this seed");
        return;
      }
      await toggle.click();
      await sleep(200);
      const less = page.getByRole("button", { name: /^Show only live chats in / }).first();
      await expect.equal(await less.getAttribute("aria-expanded"), "true");
      covered("Sidebar › project toggle reveals older chats");
      await less.click();
      await sleep(150);
    },
    { control: "Sidebar › project toggle", severity: "wrong" },
  );

  t.test(
    "Open project button in the web build",
    async ({ page, open, sleep, defect, covered }) => {
      await open("/");
      await sleep(500);
      const urlBefore = page.url();
      const projectCountBefore = await page
        .getByRole("group", { name: "Projects" })
        .getByRole("button")
        .count();
      // The browser fallback asks for an absolute path with window.prompt (no macOS folder picker without the
      // desktop bridge). Playwright would auto-dismiss it silently; catch it, then cancel.
      let prompted = null;
      page.once("dialog", async (d) => {
        prompted = d.type() === "prompt" ? d.message() : null;
        await d.dismiss();
      });
      await page.getByRole("button", { name: "Open project" }).click();
      await sleep(600);
      if (prompted) {
        covered("Sidebar › Open project button (browser path prompt)", prompted);
        return;
      }
      const toastCount = await page
        .locator('[data-sonner-toast], [role="alertdialog"], [role="dialog"]')
        .count();
      const urlAfter = page.url();
      const projectCountAfter = await page
        .getByRole("group", { name: "Projects" })
        .getByRole("button")
        .count();
      covered("Sidebar › Open project button");
      if (toastCount === 0 && urlAfter === urlBefore && projectCountAfter === projectCountBefore) {
        await defect({
          control: "Sidebar › Open project button",
          expected:
            "Clicking Open project in the browser (no window.shellBridge) shows a fallback " +
            "(e.g. a toast explaining folders can only be added from the desktop app) or a disabled " +
            "control with a reason.",
          actual:
            "The click is a silent no-op: no dialog, no toast, no visible change of any kind. " +
            "useAddLocalFolderProject calls dialogs.pickFolder(), which resolves to null with no " +
            "shellBridge, and the handler just returns.",
          severity: "broken",
        });
      }
    },
    { control: "Sidebar › Open project button", severity: "broken" },
  );

  t.test(
    "filter box filters threads across projects",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      const input = page.getByLabel("Search chats");
      await input.fill("[a02] chat one");
      await sleep(250);
      await expect.ok(
        await page.getByRole("button", { name: "[a02] chat one", exact: true }).isVisible(),
      );
      await expect.equal(
        await page.getByRole("button", { name: "[a02] chat two", exact: true }).count(),
        0,
      );
      // A project-name match keeps every chat in that project.
      await input.fill("dirty-app");
      await sleep(250);
      await expect.ok(await page.getByRole("button", { name: /^dirty-app/ }).isVisible());
      covered("Sidebar › filter box (title + folder-name match)");
      await input.fill("");
    },
    { control: "Sidebar › filter box", severity: "wrong" },
  );

  t.test(
    "filter clear button and Escape both clear the filter",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      const input = page.getByLabel("Search chats");
      await input.fill("nonexistent-query-xyz");
      await sleep(200);
      const clearBtn = page.getByRole("button", { name: "Clear search" });
      await expect.ok(await clearBtn.isVisible());
      await clearBtn.click();
      await expect.equal(await input.inputValue(), "");
      covered("Sidebar › filter clear button");

      await input.fill("nonexistent-query-xyz");
      await sleep(200);
      await input.press("Escape");
      await expect.equal(await input.inputValue(), "", "Escape should clear the filter");
      covered("Sidebar › filter Escape clears");
    },
    { control: "Sidebar › filter clear / Escape", severity: "wrong" },
  );

  t.test(
    "filter box shows a no-results state for an unmatched query",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      const input = page.getByLabel("Search chats");
      await input.fill("zzz-no-such-thread-zzz");
      await sleep(250);
      await expect.ok(await page.getByText(/No chats match/).isVisible());
      covered("Sidebar › filter no-results state");
      await input.fill("");
    },
    { control: "Sidebar › filter no-results", severity: "wrong" },
  );
});
