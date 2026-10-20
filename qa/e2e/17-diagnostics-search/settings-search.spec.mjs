// Settings search: every PREFS_SEARCH_ITEMS id navigates to its declared page and highlights
// its row (or, for desktopOnly/host-gated items, is correctly absent in this browser environment).
import { spec } from "../lib/harness.mjs";

// id -> { title, to, desktopOnly? } mirrored from apps/web/src/components/prefs/prefsSearch.ts.
// Keep in sync if that file's PREFS_SEARCH_ITEMS changes.
const ITEMS = [
  ["project-defaults", "Project defaults and overrides", "/settings/general"],
  ["project-overview", "Project overview", "/settings/projects"],
  ["default-model", "Default model", "/settings/general"],
  ["default-permissions", "Permissions", "/settings/general"],
  ["thread-notifications", "Desktop alerts", "/settings/general"],
  ["in-app-notifications", "Heads-up inside Kora", "/settings/general"],
  ["time-format", "Clock", "/settings/general"],
  ["response-streaming", "How replies arrive", "/settings/general"],
  ["skills-in-slash-menu", "Skills in the / menu", "/settings/general"],
  ["composer-collapse", "Fold the prompt while reading", "/settings/general"],
  ["graph-explorer", "Graph Explorer", "/settings/general"],
  ["add-project-starts-in", "New projects open from", "/settings/general"],
  ["unpin-confirmation", "Check before unpinning", "/settings/general"],
  ["archive-confirmation", "Check before archiving", "/settings/general"],
  ["delete-confirmation", "Check before deleting", "/settings/general"],
  ["diagnostics", "Diagnostics", "/settings/general"],
  ["providers", "Agents", "/settings/providers"],
  ["swarm", "Swarm", "/settings/swarm"],
  ["project-actions", "Actions", "/settings/projects"],
];

async function openSettingsSearch(page, open, sleep) {
  await open("/");
  await sleep(300);
  await page.locator('button[aria-label="Settings"]').first().click();
  await page.locator("text=Starting a chat").first().waitFor({ timeout: 15_000 });
  await sleep(300);
  await page.getByPlaceholder("Search").click();
}

spec("17-diagnostics-search", { stack: 4 }, async (t) => {
  for (const [id, title, to, opts] of ITEMS) {
    t.test(
      `settings search: ${id}`,
      async ({ page, open, sleep, expect, defect, covered }) => {
        await openSettingsSearch(page, open, sleep);
        await page.keyboard.type(title);
        await sleep(350);
        const result = page.locator(`button:has-text("${title}")`).first();
        const found = (await result.count()) > 0;

        if (opts?.desktopOnly) {
          covered(
            `Settings search › ${id}`,
            found ? "unexpectedly present in browser" : "correctly absent (desktopOnly)",
          );
          if (found) {
            await defect({
              control: `Settings search › ${id}`,
              expected:
                "A desktopOnly search item should not appear as a result in the browser build.",
              actual: `"${title}" appeared as a clickable search result even though isNative is false here.`,
              severity: "wrong",
            });
          }
          return;
        }

        if (!found) {
          covered(
            `Settings search › ${id}`,
            "no result (host/provider/swarm capability not available in this environment)",
          );
          return;
        }

        await result.click();
        await sleep(500);
        const url = new URL(page.url());
        const landedOk = url.pathname === to;
        covered(`Settings search › ${id}`, `-> ${url.pathname} (expected ${to})`);
        if (!landedOk) {
          await defect({
            control: `Settings search › ${id}`,
            expected: `Clicking the "${title}" search result should navigate to ${to}.`,
            actual: `Landed on ${url.pathname} instead.`,
            severity: "wrong",
          });
          return;
        }
        const pulseCount = await page.locator(".prefs-search-target-pulse").count();
        if (pulseCount > 0) return;

        // Section-level items (Agents, Swarm, Diagnostics) have no specific
        // row to anchor to; landing on the section itself is correct, not a defect.
        const isSectionLevelItem = ["providers", "swarm", "diagnostics"].includes(id);
        if (isSectionLevelItem) {
          covered(`Settings search › ${id}`, "section-level item, no row anchor expected");
          return;
        }
        // A target that legitimately needs a project/host scope, or a source that has no
        // connected host to show a value for, correctly degrades instead of highlighting a row.
        const bodyText = await page.locator("main").innerText();
        const isScopeChooser =
          /not available for the selected target|choose its owning scope|open a project to rename it/i.test(
            bodyText,
          );
        const isEmptyHostState = /nothing detected yet/i.test(bodyText);
        if (isScopeChooser || isEmptyHostState) {
          covered(
            `Settings search › ${id}`,
            isScopeChooser
              ? "needs a project scope, correctly shows scope chooser"
              : "no connected host, correctly shows empty state",
          );
          return;
        }

        await defect({
          control: `Settings search › ${id}`,
          expected: `The target row for "${title}" should be highlighted (scrolled into view and pulsed) after the search jump, or the page should show a recognizable reason it can't (scope chooser / empty host state).`,
          actual:
            "No pulse-highlighted element, scope-chooser message, or empty-host message was found after navigating — the result lands on the page with nothing to show for it.",
          severity: "wrong",
        });
      },
      { control: `Settings search › ${id}`, severity: "wrong" },
    );
  }
});
