import { spec } from "../lib/harness.mjs";

// Settings → Swarm: Supply mode (Free first / Paid first / Local only), the paid-model cap, and
// local model servers (Ollama / LM Studio). Stack 4 has Ollama running with 6 models and no
// OpenRouter key, so "Paid models" stays gated behind "Save your OpenRouter key above first."
spec("16-settings-swarm", { stack: 4 }, async (t) => {
  t.test("supply mode: Free first / Paid first / Local only round-trips", async (ctx) => {
    const { open, expect, covered, defect, page, sleep } = ctx;
    await open("/settings/swarm");
    // Providers, keys, local models, worker model and privacy sit under "More options" (night 2026-10-04).
    await page
      .locator("[data-swarm-more-options]:not([open]) > summary")
      .click()
      .catch(() => {});
    const group = page.getByRole("radiogroup", { name: "Which models workers try first" });
    await group.waitFor({ state: "visible", timeout: 10_000 });
    const startChecked = await group.getByRole("radio", { checked: true }).textContent();
    expect.equal(startChecked, "Free first");

    try {
      for (const label of ["Paid first", "Local only"]) {
        await group.getByRole("radio", { name: label }).click();
        await sleep(700);
        const nowChecked = await group.getByRole("radio", { checked: true }).textContent();
        if (nowChecked !== label) {
          await defect({
            control: `Supply mode: ${label}`,
            expected: `"${label}" becomes the checked radio`,
            actual: `checked radio reads "${nowChecked}"`,
            severity: "wrong",
          });
        } else {
          covered(`Supply mode: ${label}`);
        }
      }
    } finally {
      await group.getByRole("radio", { name: "Free first" }).click();
      await sleep(700);
    }
    const restored = await group.getByRole("radio", { checked: true }).textContent();
    expect.equal(restored, "Free first");
    covered("Supply mode: restored to Free first");
  });

  t.test(
    "paid models: rejects invalid caps, accepts a valid one, gated without a key",
    async (ctx) => {
      const { open, expect, covered, defect, page, sleep } = ctx;
      await open("/settings/swarm");
      // Providers, keys, local models, worker model and privacy sit under "More options" (night 2026-10-04).
      await page
        .locator("[data-swarm-more-options]:not([open]) > summary")
        .click()
        .catch(() => {});
      const panel = page.locator("[data-swarm-paid]");
      await panel.waitFor({ state: "visible", timeout: 10_000 });

      // No OpenRouter key on this stack: the switch must stay off and disabled, with a hint why.
      const sw = panel.getByRole("switch", { name: "Use paid OpenRouter models" });
      const disabled = await sw.isDisabled();
      const checked = (await sw.getAttribute("data-checked")) !== null;
      if (!disabled || checked) {
        await defect({
          control: "Paid models: Use paid OpenRouter models switch",
          expected: "off and disabled when no OpenRouter key is saved",
          actual: `disabled=${disabled} checked=${checked}`,
          severity: "wrong",
        });
      }
      expect.match(await panel.innerText(), /Save your OpenRouter key above first/);
      covered("Paid models: gated behind an OpenRouter key");

      const capInput = panel.getByLabel("Cap per task (USD)");
      const originalCap = await capInput.inputValue();

      for (const bad of ["abc", "-1", "0", "999"]) {
        await capInput.fill(bad);
        await panel.getByRole("button", { name: "Save cap" }).click();
        await sleep(400);
        const hasError = await panel.getByRole("alert").count();
        if (hasError === 0) {
          await defect({
            control: "Paid models: cap validation",
            expected: `an invalid cap ("${bad}") is rejected with an error`,
            actual: "no error shown",
            severity: "wrong",
          });
        }
      }
      covered("Paid models: cap validation rejects bad input");

      try {
        await capInput.fill("0.10");
        await panel.getByRole("button", { name: "Save cap" }).click();
        await sleep(700);
        const savedText = await panel.innerText();
        if (!/\$0\.10 a task/.test(savedText)) {
          await defect({
            control: "Paid models: Save cap",
            expected: 'the summary reads "Now $0.10 a task" after saving',
            actual: savedText.slice(0, 160),
            severity: "wrong",
          });
        } else {
          covered("Paid models: Save cap (valid value)");
        }
      } finally {
        await capInput.fill(originalCap || "0.05");
        await panel.getByRole("button", { name: "Save cap" }).click();
        await sleep(700);
      }
    },
  );

  t.test("local models: Ollama is listed with its model picker; Check again works", async (ctx) => {
    const { open, expect, covered, defect, page, sleep } = ctx;
    await open("/settings/swarm");
    // Providers, keys, local models, worker model and privacy sit under "More options" (night 2026-10-04).
    await page
      .locator("[data-swarm-more-options]:not([open]) > summary")
      .click()
      .catch(() => {});
    const ollamaRow = page.locator('[data-swarm-local-server="ollama"]');
    await ollamaRow.waitFor({ state: "visible", timeout: 10_000 });
    const text = await ollamaRow.innerText();
    if (!/running/.test(text)) {
      await defect({
        control: "Local models: Ollama row",
        expected: "Ollama reports running with its model count on this stack",
        actual: text.slice(0, 160),
        severity: "wrong",
      });
    } else {
      covered("Local models: Ollama detected running");
    }

    const select = ollamaRow.getByRole("combobox", { name: "Ollama worker model" });
    if (await select.count()) {
      await select.click();
      await sleep(300);
      const options = await page.getByRole("option").allTextContents();
      covered("Local models: Ollama model picker", options.join(", "));
      await page.keyboard.press("Escape");
      await sleep(200);
    }

    const lmStudioRow = page.locator('[data-swarm-local-server="lmstudio"]');
    expect.match(await lmStudioRow.innerText(), /not running/);
    covered("Local models: LM Studio reports not running");

    const before = await page.locator("body").innerText();
    // Two "Check again" buttons exist on this page (OpenCode section, local models section); scope
    // to the one next to the local-server rows.
    const localCheckAgain = page
      .locator("ul", { has: page.locator('[data-swarm-local-server="ollama"]') })
      .locator("..")
      .getByRole("button", { name: "Check again" });
    await localCheckAgain.click();
    await sleep(1500);
    const after = await page.locator("body").innerText();
    if (!/Ollama/.test(after)) {
      await defect({
        control: "Local models: Check again",
        expected: "servers are still listed after re-checking",
        actual: after.slice(0, 160),
        severity: "wrong",
      });
    } else {
      covered("Local models: Check again");
    }
  });
});
