import { spec } from "../lib/harness.mjs";

// Settings → Swarm: the privacy consent notice (stack 4 starts unaccepted) and the default worker
// model picker. Consent is toggled by clicking it (not on a Save button), so every test that accepts
// it restores the unaccepted state in a `finally` block.
spec("16-settings-swarm", { stack: 4 }, async (t) => {
  t.test("privacy notice starts unaccepted; accept then withdraw round-trips", async (ctx) => {
    const { open, expect, covered, defect, page, sleep } = ctx;
    await open("/settings/swarm");
    // Providers, keys, local models, worker model and privacy sit under "More options" (night 2026-10-04).
    await page
      .locator("[data-swarm-more-options]:not([open]) > summary")
      .click()
      .catch(() => {});
    const section = page.locator("section", {
      has: page.getByRole("heading", { name: "Privacy" }),
    });
    await section.waitFor({ state: "visible", timeout: 10_000 });
    expect.match(await section.innerText(), /Not accepted\. Swarm stays off/);
    covered("Privacy notice: starts unaccepted on this stack");

    const checkboxLabel = page.getByText(
      "I understand free-model providers may store and train on what workers send.",
    );

    try {
      await checkboxLabel.click();
      await sleep(1000);
      const acceptedText = await section.innerText();
      if (!/Accepted /.test(acceptedText)) {
        await defect({
          control: "Privacy notice: accept",
          expected: 'the notice reads "Accepted <date>." once checked',
          actual: acceptedText.slice(0, 160),
          severity: "wrong",
        });
      } else {
        covered("Privacy notice: accept (shows accepted date)");
      }
      const withdrawBtn = page.getByRole("button", { name: "Withdraw consent" });
      if ((await withdrawBtn.count()) === 0) {
        await defect({
          control: "Privacy notice: Withdraw consent button",
          expected: "a Withdraw consent button appears once accepted",
          actual: "not found",
          severity: "wrong",
        });
      }
    } finally {
      const withdrawBtn = page.getByRole("button", { name: "Withdraw consent" });
      if (await withdrawBtn.count()) {
        await withdrawBtn.click();
        await sleep(1000);
      }
    }
    const restored = await section.innerText();
    expect.match(restored, /Not accepted\. Swarm stays off/);
    covered("Privacy notice: withdraw consent (restored to unaccepted)");
  });

  t.test("privacy checkbox reflects consent state after a reload", async (ctx) => {
    const { open, expect, covered, page, sleep } = ctx;
    await open("/settings/swarm");
    // Providers, keys, local models, worker model and privacy sit under "More options" (night 2026-10-04).
    await page
      .locator("[data-swarm-more-options]:not([open]) > summary")
      .click()
      .catch(() => {});
    const checkboxLabel = page.getByText(
      "I understand free-model providers may store and train on what workers send.",
    );
    await checkboxLabel.waitFor({ state: "visible", timeout: 10_000 });
    try {
      await checkboxLabel.click();
      await sleep(1000);
      await open("/settings/swarm");
      // Providers, keys, local models, worker model and privacy sit under "More options" (night 2026-10-04).
      await page
        .locator("[data-swarm-more-options]:not([open]) > summary")
        .click()
        .catch(() => {});
      const section = page.locator("section", {
        has: page.getByRole("heading", { name: "Privacy" }),
      });
      await section.waitFor({ state: "visible", timeout: 10_000 });
      expect.match(await section.innerText(), /Accepted /);
      covered("Privacy notice: consent persists across a reload");
    } finally {
      const withdrawBtn = page.getByRole("button", { name: "Withdraw consent" });
      if (await withdrawBtn.count()) {
        await withdrawBtn.click();
        await sleep(1000);
      }
    }
  });

  t.test("default worker model select: change then restore to Automatic", async (ctx) => {
    const { open, expect, covered, defect, page, sleep } = ctx;
    await open("/settings/swarm");
    // Providers, keys, local models, worker model and privacy sit under "More options" (night 2026-10-04).
    await page
      .locator("[data-swarm-more-options]:not([open]) > summary")
      .click()
      .catch(() => {});
    const trigger = page.getByRole("combobox", { name: "Default swarm model" });
    await trigger.waitFor({ state: "visible", timeout: 10_000 });
    expect.match(await trigger.innerText(), /Automatic \(best available\)/);

    await trigger.click();
    await sleep(300);
    const options = await page.getByRole("option").allTextContents();
    covered("Default model select: options listed", options.join(", "));
    if (options.length < 2) {
      await defect({
        control: "Default worker model select",
        expected: "at least one free model besides Automatic, given Zen works on this stack",
        actual: options.join(", "),
        severity: "wrong",
      });
      await page.keyboard.press("Escape");
      return;
    }
    const target = options[1];

    try {
      await page.getByRole("option", { name: target }).click();
      await sleep(700);
      const selectedText = await trigger.innerText();
      if (!selectedText.includes(target)) {
        await defect({
          control: "Default worker model select: choose a model",
          expected: `the trigger shows "${target}" after picking it`,
          actual: selectedText,
          severity: "wrong",
        });
      } else {
        covered("Default worker model select: choose a specific model");
      }
    } finally {
      await trigger.click();
      await sleep(300);
      await page.getByRole("option", { name: "Automatic (best available)" }).click();
      await sleep(700);
    }
    const restored = await trigger.innerText();
    expect.match(restored, /Automatic \(best available\)/);
    covered("Default worker model select: restored to Automatic");
  });

  t.test("Escape closes the default model select without changing the value", async (ctx) => {
    const { open, expect, covered, page, sleep } = ctx;
    await open("/settings/swarm");
    // Providers, keys, local models, worker model and privacy sit under "More options" (night 2026-10-04).
    await page
      .locator("[data-swarm-more-options]:not([open]) > summary")
      .click()
      .catch(() => {});
    const trigger = page.getByRole("combobox", { name: "Default swarm model" });
    await trigger.waitFor({ state: "visible", timeout: 10_000 });
    await trigger.click();
    await sleep(300);
    await page.keyboard.press("Escape");
    await sleep(300);
    expect.equal(await page.getByRole("option").count(), 0);
    expect.match(await trigger.innerText(), /Automatic \(best available\)/);
    covered("Default worker model select: Escape closes without changing value");
  });
});
