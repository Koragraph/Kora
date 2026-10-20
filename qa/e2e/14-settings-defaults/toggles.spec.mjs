// Settings → Defaults: every plain on/off switch row. Each is flipped, verified, and flipped
// back so the run is idempotent; a sample of rows also exercises the per-row reset button.
import { spec } from "../lib/harness.mjs";

const SWITCH_LABELS = [
  "Graph Explorer",
  "Check before unpinning",
  "Check before archiving",
  "Check before deleting",
  "Heads-up inside Kora",
  "Skills in the / menu",
  "Fold the prompt while reading",
];

async function openDefaults(page, open, sleep) {
  await open("/");
  await sleep(300);
  await page.locator('button[aria-label="Settings"]').first().click();
  await page.locator("text=Starting a chat").first().waitFor({ timeout: 15_000 });
  await sleep(300);
}

spec("14-settings-defaults", { stack: 3 }, async (t) => {
  t.test(
    "every switch row toggles and its state reflects the click",
    async ({ page, open, sleep, expect, defect, covered }) => {
      await openDefaults(page, open, sleep);
      for (const label of SWITCH_LABELS) {
        const sw = page.locator(`[role="switch"][aria-label="${label}"]`);
        const count = await sw.count();
        if (count === 0) {
          covered(`Settings › Defaults › ${label}`, "not found on this scope, skipped");
          continue;
        }
        if ((await sw.getAttribute("aria-disabled")) === "true") {
          covered(`Settings › Defaults › ${label}`, "disabled in this environment, skipped");
          continue;
        }
        const before = await sw.getAttribute("data-checked");
        await sw.click();
        await sleep(200);
        const after = await sw.getAttribute("data-checked");
        covered(`Settings › Defaults › ${label} toggle`, `${before} -> ${after}`);
        if (before === after) {
          // Confirmed via three input methods (click, Space, Enter) during triage — not a
          // one-off flake. Record and move on so the rest of the switches still get covered.
          await defect({
            control: `Settings › Defaults › ${label}`,
            expected: `Clicking the "${label}" switch should flip its checked state.`,
            actual: `data-checked stayed "${before}" after a click; the switch is enabled (not aria-disabled) but does not respond.`,
            severity: "wrong",
          });
          continue;
        }
        await expect.ok(before !== after, `${label} switch should change state on click`);
        // restore
        await sw.click();
        await sleep(150);
        const restored = await sw.getAttribute("data-checked");
        await expect.equal(restored, before, `${label} switch should restore on second click`);
      }
    },
    { control: "Settings › Defaults › switch rows", severity: "wrong" },
  );

  t.test(
    "per-row reset button restores a changed switch to default",
    async ({ page, open, sleep, expect, covered }) => {
      await openDefaults(page, open, sleep);
      const label = "Skills in the / menu";
      const sw = page.locator(`[role="switch"][aria-label="${label}"]`);
      const before = await sw.getAttribute("data-checked");
      await sw.click();
      await sleep(200);
      const resetBtn = page.locator(`button[aria-label="Reset ${label} to default"]`);
      const resetVisible = (await resetBtn.count()) > 0;
      covered(
        "Settings › Defaults › per-row reset button",
        resetVisible ? "present after change" : "not found",
      );
      if (resetVisible) {
        await resetBtn.click();
        await sleep(200);
        const after = await sw.getAttribute("data-checked");
        await expect.equal(
          after,
          before,
          "reset button should restore the row to its default value",
        );
      } else {
        // restore manually so the suite stays clean
        await sw.click();
        await sleep(150);
      }
    },
    { control: "Settings › Defaults › per-row reset", severity: "wrong" },
  );

  t.test(
    "a changed switch persists across reload, then is restored",
    async ({ page, open, sleep, expect, covered }) => {
      await openDefaults(page, open, sleep);
      const label = "Skills in the / menu";
      const sw = page.locator(`[role="switch"][aria-label="${label}"]`);
      const before = await sw.getAttribute("data-checked");
      await sw.click();
      await sleep(250);
      const changed = await sw.getAttribute("data-checked");

      await openDefaults(page, open, sleep);
      const swAfterReload = page.locator(`[role="switch"][aria-label="${label}"]`);
      const afterReload = await swAfterReload.getAttribute("data-checked");
      covered("Settings › Defaults › switch persists on reload", `${changed} -> ${afterReload}`);
      await expect.equal(afterReload, changed, "the switch value should persist across reload");

      // restore
      await swAfterReload.click();
      await sleep(200);
      const restored = await swAfterReload.getAttribute("data-checked");
      await expect.equal(restored, before, "should restore to original value");
    },
    { control: "Settings › Defaults › persists on reload", severity: "wrong" },
  );
});
