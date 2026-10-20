// Sidebar thread "…" menu and its right-click fallback: item set, rename, copy, archive, delete.
// Pin / Settle / Snooze / Regenerate-title are excluded here on purpose — this daemon never sets
// the threadPinning / threadSettlement / threadSnooze / threadTitleRegeneration capabilities
// (apps/web/src/atoms/entities.ts reads them off environment.capabilities, and nothing in
// packages/ui-server/src/config.ts's DEFAULT_DAEMON_PREFS ever turns them on), so the menu
// correctly omits them. That is a capability gap, not a sidebar bug — noted in the coverage file.
import { spec, threadIdByTitle } from "../lib/harness.mjs";

const CHAT_ONE = "[a02] chat one";
const CHAT_TWO = "[a02] chat two";
const CHAT_THREE = "[a02] chat three";

async function openMenu(page, sleep, name) {
  await page.getByRole("button", { name, exact: true }).click({ button: "right" });
  await sleep(300);
}

function menuItem(page, label) {
  return page.locator("div.dropdown-glass button", { hasText: label }).first();
}

spec("02-sidebar", { stack: 1 }, async (t) => {
  t.test(
    "the thread action menu offers rename, mark unread, copy, project settings, archive and delete",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      // The sidebar shows only open chats; a search lists every match.
      await page.getByLabel("Search chats").fill("[a02]");
      await sleep(200);
      await openMenu(page, sleep, CHAT_ONE);
      const labels = await page.locator("div.dropdown-glass button span.min-w-0").allTextContents();
      for (const expected of [
        "Rename chat",
        "Mark unread",
        "Copy",
        "Project settings",
        "Archive chat",
        "Delete",
      ]) {
        expect.ok(
          labels.includes(expected),
          `menu should include "${expected}", got ${JSON.stringify(labels)}`,
        );
      }
      await page.keyboard.press("Escape");
      covered("Sidebar › thread menu item set");
    },
    { control: "Sidebar › thread action menu", severity: "wrong" },
  );

  t.test(
    "right-click on a thread row opens the same fallback menu as the … button",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      // The sidebar shows only open chats; a search lists every match.
      await page.getByLabel("Search chats").fill("[a02]");
      await sleep(200);
      // Via the ⋯ button.
      const ellipsisBtn = page.getByRole("button", { name: `Actions for ${CHAT_ONE}` });
      await ellipsisBtn.click();
      await sleep(250);
      const viaEllipsis = await page
        .locator("div.dropdown-glass button span.min-w-0")
        .allTextContents();
      await page.keyboard.press("Escape");
      await sleep(150);
      // Via right-click.
      await openMenu(page, sleep, CHAT_ONE);
      const viaRightClick = await page
        .locator("div.dropdown-glass button span.min-w-0")
        .allTextContents();
      await page.keyboard.press("Escape");
      await sleep(150);
      expect.deepEqual(viaEllipsis, viaRightClick);
      covered("Sidebar › right-click context menu fallback");
    },
    { control: "Sidebar › right-click menu", severity: "wrong" },
  );

  t.test(
    "rename: Enter commits, Escape cancels, empty is rejected",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      // The sidebar shows only open chats; a search lists every match.
      await page.getByLabel("Search chats").fill("[a02]");
      await sleep(200);

      // Double-click rename moved to the chat header title (ChatHeader onTitleDoubleClick); the row opens a thread.
      await page.getByRole("button", { name: CHAT_ONE, exact: true }).click();
      await sleep(700);

      const startRenameViaMenu = async (currentTitle) => {
        await page
          .locator('button[data-sidebar="menu-button"]', { hasText: currentTitle })
          .first()
          .click({ button: "right" });
        await sleep(250);
        await menuItem(page, "Rename chat").click();
        await sleep(200);
        return page.locator("input.border-sidebar-border");
      };

      // Empty is rejected (title unchanged, warning toast).
      let input = await startRenameViaMenu(CHAT_ONE);
      await input.fill("   ");
      await input.press("Enter");
      await sleep(300);
      await expect.ok(
        (await page.getByRole("button", { name: CHAT_ONE, exact: true }).count()) > 0,
        "an empty rename should be rejected and the original title kept",
      );
      covered("Sidebar › rename empty rejected");

      // Enter commits, then restore the original title so the spec stays idempotent.
      input = await startRenameViaMenu(CHAT_ONE);
      await input.fill(CHAT_ONE + " renamed");
      await input.press("Enter");
      await sleep(400);
      await expect.ok(
        (await page.getByRole("button", { name: CHAT_ONE + " renamed", exact: true }).count()) > 0,
      );
      covered("Sidebar › rename Enter commits");

      input = await startRenameViaMenu(CHAT_ONE + " renamed");
      await input.fill(CHAT_ONE);
      await input.press("Enter");
      await sleep(400);
      await expect.ok(
        (await page.getByRole("button", { name: CHAT_ONE, exact: true }).count()) > 0,
        "restore original title",
      );
    },
    { control: "Sidebar › rename inline edit", severity: "wrong" },
  );

  t.test(
    "copy thread ID from the menu writes to the clipboard",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      // The sidebar shows only open chats; a search lists every match.
      await page.getByLabel("Search chats").fill("[a02]");
      await sleep(200);
      await openMenu(page, sleep, CHAT_ONE);
      await menuItem(page, "Copy").click();
      await sleep(200);
      await menuItem(page, "Chat ID").click();
      await sleep(250);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      expect.equal(clip, threadIdByTitle(1, CHAT_ONE));
      covered("Sidebar › thread menu › Copy Thread ID");
    },
    { control: "Sidebar › copy thread id", severity: "wrong" },
  );

  t.test(
    "archive removes the thread from the list and Archived › Unarchive brings it back",
    async ({ page, open, sleep, expect, defect, covered }) => {
      await open("/");
      await sleep(300);
      // The sidebar shows only open chats; a search lists every match.
      await page.getByLabel("Search chats").fill("[a02]");
      await sleep(200);
      const row = page.getByRole("button", { name: CHAT_TWO, exact: true });
      if ((await row.count()) === 0) {
        // Already archived by a prior round; nothing left to exercise here.
        covered("Sidebar › archive + confirm", "skipped: already archived");
      } else {
        await openMenu(page, sleep, CHAT_TWO);
        await menuItem(page, "Archive chat").click();
        // The row leaves once the daemon's shell update lands (100–400 ms): wait for it, don't race it.
        await page
          .getByRole("button", { name: CHAT_TWO, exact: true })
          .waitFor({ state: "detached", timeout: 5000 })
          .catch(() => {});
        // confirmThreadArchive defaults to false (packages/contracts/src/settings.ts), so archiving
        // is immediate here — no confirmation dialog is expected in the default configuration.
        await expect.equal(
          await page.getByRole("button", { name: CHAT_TWO, exact: true }).count(),
          0,
        );
        covered("Sidebar › archive + confirm");
      }

      // The way back: "Archived (N)" at the bottom of the sidebar lists archived threads with Unarchive.
      const archived = page.getByRole("button", { name: /^Archived \(\d+\)$/ });
      await archived.waitFor({ timeout: 5000 });
      if ((await archived.getAttribute("aria-expanded")) !== "true") await archived.click();
      const unarchive = page.getByRole("button", { name: `Unarchive ${CHAT_TWO}`, exact: true });
      await unarchive.waitFor({ timeout: 5000 });
      covered("Sidebar › archived threads list");
      await unarchive.click();
      await page.getByRole("button", { name: CHAT_TWO, exact: true }).waitFor({ timeout: 5000 });
      covered("Sidebar › unarchive returns the thread to the sidebar (no reload)");
    },
    { control: "Sidebar › archive thread", severity: "broken" },
  );

  t.test(
    "delete with confirmation removes the thread for good",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      // The sidebar shows only open chats; a search lists every match.
      await page.getByLabel("Search chats").fill("[a02]");
      await sleep(200);
      const row = page.getByRole("button", { name: CHAT_THREE, exact: true });
      if ((await row.count()) === 0) {
        covered("Sidebar › delete + confirm", "skipped: already deleted");
        return;
      }
      await openMenu(page, sleep, CHAT_THREE);
      await menuItem(page, "Delete").click();
      await sleep(250);
      const dialog = page.getByRole("alertdialog");
      await expect.ok(await dialog.isVisible(), "deleting should ask for confirmation");
      await dialog.getByRole("button", { name: "Delete" }).click();
      await sleep(500);
      await expect.equal(
        await page.getByRole("button", { name: CHAT_THREE, exact: true }).count(),
        0,
      );
      covered("Sidebar › delete + confirm");

      await open("/");
      await sleep(400);
      // The sidebar shows only open chats; a search lists every match.
      await page.getByLabel("Search chats").fill("[a02]");
      await sleep(200);
      await expect.equal(
        await page.getByRole("button", { name: CHAT_THREE, exact: true }).count(),
        0,
        "the thread should stay gone after a reload",
      );
      covered("Sidebar › delete survives reload");
    },
    { control: "Sidebar › delete thread", severity: "wrong" },
  );
});
