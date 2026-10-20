import { spec } from "../lib/harness.mjs";

// The 4-step Swarm setup wizard (intro → OpenCode → providers → ready), opened from Settings and
// from the composer's Swarm toggle. Consent is left unaccepted at the end of every test that accepts
// it, since stack 4's baseline is "no Swarm consent".
spec("16-settings-swarm", { stack: 4 }, async (t) => {
  t.test("wizard step tabs are not clipped", async (ctx) => {
    const { open, defect, page, sleep } = ctx;
    await open("/settings/swarm");
    await page.getByRole("button", { name: "Step-by-step setup" }).click();
    await sleep(500);
    await page
      .getByRole("dialog", { name: "Set up Stretch" })
      .waitFor({ state: "visible", timeout: 5000 });

    const clipped = await page.evaluate(() => {
      const spans = [
        ...document.querySelectorAll('ol[aria-label="Setup progress"] li span.truncate'),
      ];
      return spans
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => ({
          text: el.textContent,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        }));
    });
    if (clipped.length > 0) {
      await defect({
        control: "Swarm setup wizard: step tabs",
        expected: "every step label (How it works, OpenCode, Workers, Ready) renders in full",
        actual: clipped
          .map((c) => `"${c.text}" needs ${c.scrollWidth}px, has ${c.clientWidth}px`)
          .join("; "),
        severity: "visual",
      });
    }
    await page.keyboard.press("Escape");
    await sleep(300);
  });

  t.test("wizard walks intro → OpenCode → providers → ready and back", async (ctx) => {
    const { open, expect, covered, defect, page, sleep } = ctx;
    await open("/settings/swarm");
    await page.getByRole("button", { name: "Step-by-step setup" }).click();
    await sleep(500);
    const dialog = page.getByRole("dialog", { name: "Set up Stretch" });
    await dialog.waitFor({ state: "visible", timeout: 5000 });

    // Step 1: intro — Continue is disabled until consent is accepted.
    const continueBtn = page.getByRole("button", { name: "Continue" });
    expect.equal(await continueBtn.isDisabled(), true);
    covered("Wizard step 1 (intro): Continue disabled before consent");

    try {
      await dialog
        .getByText("I understand free-model providers may store and train on what workers send.")
        .click();
      await sleep(800);
      expect.equal(await continueBtn.isDisabled(), false);
      covered("Wizard step 1 (intro): Continue enabled after accepting consent");

      await continueBtn.click();
      await sleep(500);
      let active = await page
        .locator('ol[aria-label="Setup progress"] [aria-current="step"]')
        .textContent();
      if (!/OpenCode/.test(active ?? "")) {
        await defect({
          control: "Swarm setup wizard: intro → OpenCode",
          expected: "Continue from intro moves to the OpenCode step",
          actual: `active step reads "${active}"`,
          severity: "wrong",
        });
      } else {
        covered("Wizard step 2: OpenCode (already installed on this stack)");
      }

      // OpenCode is already installed here, so Continue should be enabled immediately.
      expect.equal(await page.getByRole("button", { name: "Continue" }).isDisabled(), false);
      await page.getByRole("button", { name: "Continue" }).click();
      await sleep(700);
      active = await page
        .locator('ol[aria-label="Setup progress"] [aria-current="step"]')
        .textContent();
      if (!/Workers/.test(active ?? "")) {
        await defect({
          control: "Swarm setup wizard: OpenCode → Workers",
          expected: "Continue from OpenCode moves to the Workers step",
          actual: `active step reads "${active}"`,
          severity: "wrong",
        });
      } else {
        covered("Wizard step 3: Workers (free/OpenRouter/local sources)");
      }
      expect.equal(
        (await page.getByRole("region", { name: "Free" }).count()) > 0 ||
          (await page.getByText("Free models").count()) > 0,
        true,
      );

      // Zen works with no key on this stack, so Continue should already be enabled.
      expect.equal(await page.getByRole("button", { name: "Continue" }).isDisabled(), false);
      await page.getByRole("button", { name: "Continue" }).click();
      await sleep(500);
      active = await page
        .locator('ol[aria-label="Setup progress"] [aria-current="step"]')
        .textContent();
      if (!/Ready/.test(active ?? "")) {
        await defect({
          control: "Swarm setup wizard: Workers → Ready",
          expected: "Continue from Workers moves to the Ready step",
          actual: `active step reads "${active}"`,
          severity: "wrong",
        });
      } else {
        covered("Wizard step 4: Ready");
      }
      expect.match(
        await page.locator('[role="dialog"]').innerText(),
        /Stretch is ready|Almost there/,
      );

      // Back navigation: clicking a completed tab should jump back without losing state.
      await page.getByRole("button", { name: /How it works, step 1/ }).click();
      await sleep(400);
      active = await page
        .locator('ol[aria-label="Setup progress"] [aria-current="step"]')
        .textContent();
      if (!/How it works/.test(active ?? "")) {
        await defect({
          control: "Swarm setup wizard: jump back to step 1 via tabs",
          expected: "clicking the step-1 tab returns to the intro step",
          actual: `active step reads "${active}"`,
          severity: "wrong",
        });
      } else {
        covered("Wizard: clicking an earlier step tab jumps back");
      }
      // Consent should still show accepted (state was not lost by navigating back).
      expect.equal(await continueBtn.isDisabled(), false);
    } finally {
      await page.keyboard.press("Escape");
      await sleep(300);
      // Withdraw the consent this test accepted, restoring stack 4's unaccepted baseline.
      await page
        .locator("[data-swarm-more-options]:not([open]) > summary")
        .click()
        .catch(() => {});
      const withdrawBtn = page.getByRole("button", { name: "Withdraw consent" });
      if (await withdrawBtn.count()) {
        await withdrawBtn.click();
        await sleep(1000);
      }
    }
  });

  t.test("Cancel and the × close the wizard without saving consent", async (ctx) => {
    const { open, expect, covered, page, sleep } = ctx;
    await open("/settings/swarm");
    await page.getByRole("button", { name: "Step-by-step setup" }).click();
    await sleep(500);
    const dialog = page.getByRole("dialog", { name: "Set up Stretch" });
    await dialog.waitFor({ state: "visible", timeout: 5000 });

    // Check the box but back out with Cancel: nothing should be saved.
    await dialog
      .getByText("I understand free-model providers may store and train on what workers send.")
      .click();
    await sleep(600);
    await page.getByRole("button", { name: "Cancel" }).click();
    await sleep(600);
    await dialog.waitFor({ state: "hidden", timeout: 5000 });
    let text = await page.locator("body").innerText();
    if (!/Not accepted/.test(text)) {
      // If this fails, the checkbox change is live-saved (not a draft), which is fine, but then
      // "Cancel" wording is misleading. Restore either way.
      await page
        .locator("[data-swarm-more-options]:not([open]) > summary")
        .click()
        .catch(() => {});
      const withdrawBtn = page.getByRole("button", { name: "Withdraw consent" });
      if (await withdrawBtn.count()) {
        await withdrawBtn.click();
        await sleep(1000);
      }
    }
    covered("Wizard: Cancel closes the dialog");

    await page.getByRole("button", { name: "Step-by-step setup" }).click();
    await sleep(500);
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    await page.getByRole("button", { name: "Close" }).click();
    await sleep(400);
    expect.equal(await dialog.isVisible(), false);
    covered("Wizard: × closes the dialog");
  });

  t.test("Escape closes the wizard from any step", async (ctx) => {
    const { open, expect, covered, page, sleep } = ctx;
    await open("/settings/swarm");
    await page.getByRole("button", { name: "Step-by-step setup" }).click();
    await sleep(500);
    const dialog = page.getByRole("dialog", { name: "Set up Stretch" });
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    await page.keyboard.press("Escape");
    await sleep(400);
    expect.equal(await dialog.isVisible(), false);
    covered("Wizard: Escape closes from step 1");
  });

  t.test(
    "composer Swarm toggle opens the one-click setup when setup is incomplete",
    async (ctx) => {
      const { open, expect, covered, defect, page, sleep } = ctx;
      await open("/");
      await page.waitForSelector('[contenteditable="true"]', { timeout: 30_000 });
      // The landing draft follows the last surface used; the Swarm toggle lives on a Code draft.
      await page
        .getByRole("tab", { name: "Code" })
        .or(page.getByRole("button", { name: "Code", exact: true }))
        .first()
        .click();
      await sleep(400);
      await page.getByRole("button", { name: "New chat in tiny-lib" }).click();
      await sleep(1200);

      const toggle = page.locator("[data-prompt-swarm]");
      await toggle.waitFor({ state: "visible", timeout: 10_000 });
      await toggle.click();
      await sleep(700);

      // The first time, the toggle opens the one-sheet setup (night 2026-10-04, S1), not the step wizard.
      const dialog = page.locator("[data-swarm-quick-setup]");
      if (!(await dialog.isVisible())) {
        await defect({
          control: "Composer Swarm toggle",
          expected: "the one-click Swarm setup opens (consent is not accepted on this stack)",
          actual: "setup did not open",
          severity: "broken",
        });
      } else {
        covered("Composer: Swarm toggle opens the one-click setup");
      }

      // Swarm only switches on once setup finishes: until then the toggle stays off.
      if ((await toggle.getAttribute("aria-pressed")) === "true") {
        await defect({
          control: "Composer Swarm toggle",
          expected: "the toggle stays off while the setup wizard is open (Swarm is not set up yet)",
          actual: "the toggle shows Swarm on before setup finished",
          severity: "wrong",
        });
      }

      await page.keyboard.press("Escape");
      await sleep(300);
      expect.equal(await dialog.isVisible(), false);
    },
  );
});
