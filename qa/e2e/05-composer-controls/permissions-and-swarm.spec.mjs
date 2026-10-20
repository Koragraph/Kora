// The composer box (attach · Swarm · Plan inside it, nothing under it; Council is hidden until it is built), permissions in their own
// picker beside the model picker under the harness's own names, and graph freshness beside the project name in the top bar.
import { spec } from "../lib/harness.mjs";

const PICKER = "[data-agent-model-picker]";
const PERMS = "[data-permission-picker]";

async function openThread(page, sleep, title) {
  await page.getByLabel("Search chats").fill(title);
  await sleep(250);
  await page.getByText(title, { exact: true }).first().click();
  await sleep(500);
  await page.getByLabel("Search chats").fill("");
}

spec("05-composer-controls", { stack: 1 }, async (t) => {
  t.test(
    "the box holds attach and Swarm (no Council); the old Chat|Team toggle and runtime-mode select are gone",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      await openThread(page, sleep, "[a05] chat one");
      await page.locator("[data-prompt-attach]").waitFor({ timeout: 15_000 });
      await expect.equal(await page.locator("[data-prompt-council]").count(), 0, "no Council");
      await expect.ok(
        (await page.locator("[data-prompt-swarm]").count()) > 0,
        "Swarm toggle missing",
      );
      await expect.ok(
        (await page.locator("[data-prompt-plan]").count()) > 0,
        "Plan toggle missing",
      );
      await expect.equal(
        await page.getByRole("radio", { name: "Chat" }).count(),
        0,
        "Chat|Team radios should be gone",
      );
      await expect.equal(
        await page.locator('button[aria-label="Runtime mode"]').count(),
        0,
        "runtime-mode select should be gone",
      );
      await expect.equal(
        await page.locator("[data-prompt-detached-controls]").count(),
        0,
        "no empty row under the box",
      );
      covered("Composer › box layout: attach · Swarm · Plan");

      const chip = page.locator('[data-chat-header-project] [data-testid="graph-status-chip"]');
      await expect.ok(
        (await chip.count()) > 0,
        "graph freshness chip should sit beside the project name",
      );
      covered("Header › graph freshness beside project name", await chip.first().textContent());
    },
    { control: "Composer › box layout", severity: "wrong" },
  );

  t.test(
    "permissions have their own picker under Claude's names, and the choice persists per thread",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      await openThread(page, sleep, "[a05] chat one");
      await page.locator(PERMS).click();
      await sleep(300);
      const section = page.getByTestId("model-picker-permissions");
      await section.waitFor({ timeout: 5000 });
      for (const label of ["Default", "Accept edits", "Auto", "Full access"]) {
        await expect.ok(
          (await section.getByText(label, { exact: true }).count()) > 0,
          `missing ${label}`,
        );
      }
      covered("Model picker › Claude permission names");

      await section.locator('[data-permission-mode="auto-accept-edits"]').click();
      await sleep(400);
      // A pick closes the popover (PermissionPicker): reopen it to read the new state.
      await page.locator(PERMS).click();
      await sleep(300);
      await expect.equal(
        await page
          .getByTestId("model-picker-permissions")
          .locator('[data-permission-mode="auto-accept-edits"]')
          .getAttribute("aria-checked"),
        "true",
        "Accept edits should be selected",
      );
      await page.keyboard.press("Escape");

      await open("/");
      await sleep(300);
      await openThread(page, sleep, "[a05] chat one");
      await page.locator(PERMS).click();
      await sleep(300);
      const again = page.getByTestId("model-picker-permissions");
      await expect.equal(
        await again
          .locator('[data-permission-mode="auto-accept-edits"]')
          .getAttribute("aria-checked"),
        "true",
        "the permission choice should persist across reload for this thread",
      );
      covered("Model picker › permission persists per thread");

      // Bypass shows a red shield on the trigger; restore Default so reruns start clean.
      await again.locator('[data-permission-mode="full-access"]').click();
      await sleep(300);
      await page.keyboard.press("Escape");
      await expect.ok(
        (await page.getByTestId("model-picker-danger-permission").count()) > 0,
        "danger shield missing",
      );
      covered("Model picker › bypass shows a danger shield");
      await page.locator(PERMS).click();
      await sleep(300);
      await page
        .getByTestId("model-picker-permissions")
        .locator('[data-permission-mode="approval-required"]')
        .click();
      await sleep(200);
      await page.keyboard.press("Escape");
    },
    { control: "Model picker › permissions", severity: "wrong" },
  );

  t.test(
    "a Codex model shows Codex's own permission levels",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      // A thread with messages is locked to its provider; a fresh draft can pick Codex.
      await page.getByRole("button", { name: "New chat in tiny-lib" }).click();
      await sleep(800);
      await page.locator(PICKER).click();
      await sleep(300);
      const codexTab = page.locator('[data-model-picker-agent="codex"]');
      if ((await codexTab.count()) === 0) {
        covered("Model picker › Codex permissions", "skipped: no Codex provider on this stack");
        await page.keyboard.press("Escape");
        return;
      }
      await codexTab.first().click();
      await sleep(300);
      // QA stacks have an empty CODEX_HOME: a signed-out Codex is shown but never offered (night 2026-10-04, A12).
      const unusable = page.locator("[data-model-picker-agent-unusable]");
      if ((await unusable.count()) > 0) {
        await expect.match(await unusable.innerText(), /codex login/);
        const option = page
          .locator('[data-model-picker-content] [role="option"]')
          .filter({ hasText: /GPT|Codex/ })
          .first();
        await expect.equal(await option.getAttribute("aria-disabled"), "true", "not pickable");
        covered("Model picker › signed-out Codex is not offered (one-line fix shown)");
        await page.keyboard.press("Escape");
        return;
      }
      await page
        .locator('[data-model-picker-content] [role="option"]')
        .filter({ hasText: /GPT|Codex/ })
        .first()
        .click();
      await sleep(500);
      await page.locator(PERMS).click();
      await sleep(300);
      const section = page.getByTestId("model-picker-permissions");
      for (const label of ["Read only", "Workspace write", "Full access"]) {
        await expect.ok(
          (await section.getByText(label, { exact: true }).count()) > 0,
          `missing ${label}`,
        );
      }
      await expect.equal(
        await section.getByText("Full access", { exact: true }).count(),
        0,
        "no Claude names for Codex",
      );
      covered("Model picker › Codex permission names");
      await page.keyboard.press("Escape");
      // Swarm needs a Claude lead: the toggle is disabled for Codex.
      await expect.ok(
        await page.locator("[data-prompt-swarm]").isDisabled(),
        "Swarm should be disabled for a Codex lead",
      );
      covered("Composer › Swarm disabled for a Codex lead");
    },
    { control: "Model picker › Codex permissions", severity: "wrong" },
  );

  t.test(
    "Swarm toggles on and off",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      await sleep(300);
      await openThread(page, sleep, "[a04] chat one");
      const toggle = page.locator("[data-prompt-swarm]");
      await toggle.waitFor({ timeout: 10_000 });
      const before = await toggle.getAttribute("aria-pressed");
      await toggle.click();
      await sleep(600);
      await expect.ok(
        (await toggle.getAttribute("aria-pressed")) !== before,
        "Swarm toggle should flip",
      );
      await toggle.click();
      await sleep(600);
      await expect.equal(
        await toggle.getAttribute("aria-pressed"),
        before,
        "Swarm toggle should flip back",
      );
      covered("Composer › Swarm toggle flips");
    },
    { control: "Composer › Swarm toggle", severity: "wrong" },
  );

  t.test(
    "no cold/blue colours in the model and permission pickers",
    async ({ page, open, sleep, inkCheck, defect, covered }) => {
      await open("/");
      await sleep(300);
      await openThread(page, sleep, "[a05] chat one");
      await page.locator(PICKER).click();
      await sleep(300);
      const hits = await inkCheck();
      const cold = hits.filter((h) => h.kind === "cold");
      covered("Model picker › palette", `${cold.length} cold hit(s)`);
      if (cold.length > 0) {
        await defect({
          control: "Model picker colours",
          expected: "Ink palette: no cold/blue hues in the model picker.",
          actual: `inkCheck found cold hues: ${JSON.stringify(cold.slice(0, 3))}`,
          severity: "visual",
        });
      }
      await page.keyboard.press("Escape");
    },
    { control: "Model picker › palette", severity: "visual" },
  );
});
