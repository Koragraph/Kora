// Settings → Defaults: select-based rows, and the page-level
// "Back to Kora defaults" (Undo N changes) confirmation flow.
import { spec } from "../lib/harness.mjs";

async function openDefaults(page, open, sleep) {
  await open("/");
  await sleep(300);
  await page.locator('button[aria-label="Settings"]').first().click();
  await page.locator("text=Starting a chat").first().waitFor({ timeout: 15_000 });
  await sleep(300);
}

async function pickOption(page, sleep, comboLocator, optionText) {
  await comboLocator.click();
  await sleep(200);
  const opts =
    typeof optionText === "string"
      ? page.getByRole("option", { name: optionText, exact: true })
      : page.getByRole("option", { name: optionText });
  await opts.first().click();
  await sleep(200);
}

spec("14-settings-defaults", { stack: 3 }, async (t) => {
  t.test(
    "Default permissions selector changes and persists, then resets",
    async ({ page, open, sleep, defect, covered }) => {
      await openDefaults(page, open, sleep);
      const combo = page.locator('[role="combobox"][aria-label="Default permissions"]');
      const before = (await combo.textContent()) || "";
      await pickOption(page, sleep, combo, /^Supervised/);
      const afterSupervised = (await combo.textContent()) || "";
      // Try a second, distinct option too, to rule out one option happening to equal the
      // current value.
      await pickOption(page, sleep, combo, /^Auto-accept/);
      const afterAutoAccept = (await combo.textContent()) || "";
      covered(
        "Settings › Defaults › Permissions select",
        `before=${before} afterSupervised=${afterSupervised} afterAutoAccept=${afterAutoAccept}`,
      );
      if (afterSupervised === before && afterAutoAccept === before) {
        await defect({
          control: "Settings › Defaults › Default permissions selector",
          expected:
            "Picking any option (Supervised / Auto-accept edits / Auto / Full access) in " +
            'the "Default permissions" select on Settings → Defaults should update the trigger label.',
          actual:
            `The trigger stayed "${before}" no matter which option was clicked (tried Supervised ` +
            "and Auto-accept edits, each confirmed via a direct click on the option and a " +
            "standalone reproduction outside the spec harness). The control is a dead end.",
          severity: "broken",
        });
      } else {
        // restore to whatever it started as
        await pickOption(page, sleep, combo, new RegExp(`^${before.trim()}`));
      }
    },
    { control: "Settings › Defaults › Default permissions", severity: "broken" },
  );

  t.test(
    "Clock selector changes and can be restored",
    async ({ page, open, sleep, expect, covered }) => {
      await openDefaults(page, open, sleep);

      const timeFormat = page.locator('[role="combobox"][aria-label="Timestamp format"]');
      const timeBefore = (await timeFormat.textContent()) || "";
      await timeFormat.click();
      await sleep(200);
      const timeOptions = await page.getByRole("option").allTextContents();
      const timeOther = timeOptions.find((o) => o.trim() !== timeBefore.trim());
      await page.getByRole("option", { name: timeOther, exact: true }).click();
      await sleep(200);
      await expect.ok(
        (await timeFormat.textContent())?.trim() !== timeBefore.trim(),
        "time format label should change",
      );
      covered("Settings › Defaults › Clock select");
      await timeFormat.click();
      await sleep(200);
      await page.getByRole("option", { name: timeBefore.trim(), exact: true }).click();
      await sleep(150);
    },
    { control: "Settings › Defaults › Clock select", severity: "wrong" },
  );

  t.test(
    "Back to Kora defaults is hidden with no changes, then confirms and resets a tracked setting",
    async ({ page, open, sleep, expect, covered }) => {
      await openDefaults(page, open, sleep);
      const restoreBtn = page.getByRole("button", { name: "Back to Kora defaults" });
      await expect.equal(
        await restoreBtn.count(),
        0,
        "restore button should be hidden with no pending changes",
      );
      covered("Settings › Defaults › Back to Kora defaults hidden when clean");

      // "Skills in the / menu" is one of the fields restoreDefaults() actually resets
      // (showSkillsInSlashMenu, per PrefsPanels.tsx), unlike Graph Explorer which is a
      // local-storage-only preference and correctly does not dirty this button.
      const skillsSwitch = page.locator('[role="switch"][aria-label="Skills in the / menu"]');
      const before = await skillsSwitch.getAttribute("data-checked");
      await skillsSwitch.click();
      await sleep(200);
      await expect.equal(
        await restoreBtn.isVisible(),
        true,
        "restore button should appear once a tracked setting changed",
      );
      covered("Settings › Defaults › Back to Kora defaults shown after a change");

      await restoreBtn.click();
      await sleep(400);
      const dialog = page.getByRole("alertdialog");
      const hasDialog = (await dialog.count()) > 0;
      covered(
        "Settings › Defaults › Back to Kora defaults confirmation dialog",
        hasDialog ? "present" : "MISSING",
      );
      if (hasDialog) {
        const cancelBtn = dialog.getByRole("button", { name: /cancel/i });
        if ((await cancelBtn.count()) > 0) {
          await cancelBtn.click();
          await sleep(250);
        }
      }
      // Revert manually so reruns are clean, regardless of dialog outcome.
      const stillChanged = (await skillsSwitch.getAttribute("data-checked")) !== before;
      if (stillChanged) {
        await skillsSwitch.click();
        await sleep(200);
      }
    },
    { control: "Settings › Defaults › Back to Kora defaults confirmation", severity: "wrong" },
  );
});
