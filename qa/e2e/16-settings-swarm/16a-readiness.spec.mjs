import { spec } from "../lib/harness.mjs";

// Settings → Swarm: the Readiness checklist and the OpenCode section.
// Stack 4's daemon has OpenCode already installed (a symlink under home/tools/opencode) and starts
// without Swarm privacy consent, so "Privacy consent" always reads "needs attention" here.
spec("16-settings-swarm", { stack: 4 }, async (t) => {
  t.test("readiness checklist lists every row with a sensible state", async (ctx) => {
    const { open, expect, covered, defect, step, page } = ctx;
    await open("/settings/swarm");
    step("open Settings → Swarm");

    const list = page.getByRole("list", { name: "Swarm readiness" });
    await list.waitFor({ state: "visible", timeout: 10_000 });

    const rows = await page.locator("[data-swarm-readiness-row]").all();
    const ids = [];
    for (const row of rows) ids.push(await row.getAttribute("data-swarm-readiness-row"));
    covered("Readiness checklist", ids.join(", "));

    // Settings shows the essentials only (night 2026-10-04): consent is the "Free AI helpers" switch above, and the
    // optional providers live under More options.
    for (const expected of ["opencode", "zen", "models"]) {
      if (!ids.includes(expected)) {
        await defect({
          control: "Swarm readiness checklist",
          expected: `a "${expected}" row is present`,
          actual: `rows were: ${ids.join(", ")}`,
          severity: "wrong",
        });
      }
    }

    // OpenCode is installed on this stack: its row must read "ready" (a check icon), not a problem.
    const opencodeRow = page.locator('[data-swarm-readiness-row="opencode"]');
    const opencodeState = await opencodeRow.getAttribute("data-state");
    if (opencodeState !== "ok") {
      await defect({
        control: "Readiness row: OpenCode",
        expected: 'state "ok" (OpenCode is installed on this stack)',
        actual: `state "${opencodeState}"`,
        severity: "wrong",
      });
    }

    // Privacy consent starts unaccepted on this stack: the Free AI helpers switch reads off.
    const enabled = page.getByRole("switch", { name: "Free AI helpers (Swarm)" });
    expect.equal(await enabled.isChecked(), false);
    covered("Free AI helpers switch: off without consent");
  });

  t.test("readiness row Fix/Change links open the wizard at the right step", async (ctx) => {
    const { open, expect, covered, defect, page, sleep } = ctx;
    await open("/settings/swarm");

    // OpenCode row is "ready" -> its link reads "Change" and should open the wizard on the OpenCode step.
    await page.getByRole("button", { name: /^Change: OpenCode$/ }).click();
    await sleep(500);
    const dialog = page.getByRole("dialog", { name: "Set up Stretch" });
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    const opencodeTabActive = await page
      .locator('ol[aria-label="Setup progress"] [aria-current="step"]')
      .textContent();
    if (!/OpenCode/.test(opencodeTabActive ?? "")) {
      await defect({
        control: "Readiness row: OpenCode → Change",
        expected: "the wizard opens on the OpenCode step",
        actual: `active step reads "${opencodeTabActive}"`,
        severity: "wrong",
      });
    } else {
      covered("Readiness row Change link (OpenCode) opens wizard at OpenCode step");
    }
    await page.keyboard.press("Escape");
    await sleep(300);
    await dialog.waitFor({ state: "hidden", timeout: 5000 });

    // Turning the switch on opens the one-click setup sheet (nothing is saved until Turn on / Set up Swarm).
    await page.getByRole("switch", { name: "Free AI helpers (Swarm)" }).click();
    await page.locator("[data-swarm-quick-setup]").waitFor({ state: "visible", timeout: 5000 });
    covered("Free AI helpers switch: on opens the one-click setup");
    await page.keyboard.press("Escape");
    await sleep(300);
    expect.equal(await page.locator("[data-swarm-quick-setup]").count(), 0);
  });

  t.test("Step-by-step setup opens the wizard on the intro step", async (ctx) => {
    const { open, expect, covered, page, sleep } = ctx;
    await open("/settings/swarm");
    await page.getByRole("button", { name: "Step-by-step setup" }).click();
    await sleep(500);
    const dialog = page.getByRole("dialog", { name: "Set up Stretch" });
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    expect.equal(await page.getByText("How it works").isVisible(), true);
    covered("Status header: Step-by-step setup");
    await page.keyboard.press("Escape");
    await sleep(300);
    await dialog.waitFor({ state: "hidden", timeout: 5000 });
  });

  t.test("OpenCode section shows the found install and Check again works", async (ctx) => {
    const { open, covered, defect, page, sleep } = ctx;
    await open("/settings/swarm");
    await page
      .locator("[data-swarm-more-options]:not([open]) > summary")
      .click()
      .catch(() => {});
    const panel = page.locator('[data-swarm-install-state="found"]');
    await panel.waitFor({ state: "visible", timeout: 10_000 });
    const before = await panel.innerText();
    if (!/found/.test(before)) {
      await defect({
        control: "OpenCode section: found state",
        expected: "copy mentions OpenCode was found",
        actual: before.slice(0, 200),
        severity: "wrong",
      });
    }
    covered("OpenCode section: found state");

    await page.getByRole("button", { name: "Check again" }).first().click();
    await sleep(1500);
    const after = await panel.innerText();
    if (!/found/.test(after)) {
      await defect({
        control: "OpenCode section: Check again",
        expected: "OpenCode still reports found after Check again",
        actual: after.slice(0, 200),
        severity: "broken",
      });
    } else {
      covered(
        "OpenCode section: Check again (stays found)",
        `before="${before.slice(0, 40)}" after="${after.slice(0, 40)}"`,
      );
    }
  });
});
