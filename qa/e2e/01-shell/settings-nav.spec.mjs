// 01-shell: opening settings and returning to the last thread.
import { spec } from "../lib/harness.mjs";

spec("01-shell", { stack: 1 }, async (t) => {
  t.test(
    "settings gear (sidebar footer) opens settings",
    async ({ page, open, expect, covered }) => {
      await open("/");
      await page.getByLabel("Search chats").waitFor({ timeout: 10_000 });
      await page.getByLabel("Settings", { exact: true }).first().click();
      await page.waitForURL(/\/settings/, { timeout: 10_000 });
      await page
        .locator("[data-settings-page]")
        .first()
        .waitFor({ timeout: 10_000 })
        .catch(() => {});
      expect.match(page.url(), /\/settings/);
      covered("Settings gear opens settings");
    },
    { control: "Settings gear", severity: "broken" },
  );

  t.test(
    'settings "back" returns to the last thread',
    async ({ page, open, seed, expect, covered }) => {
      await open("/");
      const fixture = seed().threads.find((x) => x.title.startsWith("[a01] chat two"));
      await page.getByText("tiny-lib").first().click();
      await page.getByText(fixture.title).first().click();
      await page.getByText(fixture.title, { exact: true }).first().waitFor({ timeout: 10_000 });
      const threadUrl = page.url();

      await page.getByLabel("Settings", { exact: true }).first().click();
      await page.waitForURL(/\/settings/, { timeout: 10_000 });

      const back = page.getByRole("button", { name: "Back", exact: true });
      await back.waitFor({ timeout: 5000 });
      await back.click();
      await page.waitForTimeout(800);
      expect.equal(page.url(), threadUrl, "settings Back did not return to the last thread");
      covered('Settings "Back" returns to last thread');
    },
    { control: "Settings back button", severity: "broken" },
  );

  t.test(
    "settings back falls back home when there is no thread history",
    async ({ page, open, expect, covered }) => {
      await open("/settings");
      await page
        .locator("[data-settings-page]")
        .first()
        .waitFor({ timeout: 10_000 })
        .catch(() => {});
      const back = page.getByRole("button", { name: "Back", exact: true });
      await back.waitFor({ timeout: 5000 });
      await back.click();
      await page.waitForTimeout(800);
      expect.ok(
        !/\/settings/.test(page.url()),
        `Back from a settings-only history stayed on settings: ${page.url()}`,
      );
      covered("Settings back with no history falls back to home");
    },
    { control: "Settings back (no history)", severity: "wrong" },
  );
});
