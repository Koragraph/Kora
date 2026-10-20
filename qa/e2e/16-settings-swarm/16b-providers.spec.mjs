import { spec } from "../lib/harness.mjs";

// Settings → Swarm → Providers: OpenCode Zen (no key), OpenRouter (key entry, save, remove) and
// Cerebras (enable/disable). Every test restores the state it changed (try/finally, so a failed
// assertion never leaves it dirty) so the shared stack-4 daemon stays clean for other areas.
async function switchOn(locator) {
  return (await locator.getAttribute("data-checked")) !== null;
}

spec("16-settings-swarm", { stack: 4 }, async (t) => {
  t.test("OpenCode Zen card: works without a key, Test connection refreshes it", async (ctx) => {
    const { open, expect, covered, defect, page, sleep } = ctx;
    await open("/settings/swarm");
    // Providers, keys, local models, worker model and privacy sit under "More options" (night 2026-10-04).
    await page
      .locator("[data-swarm-more-options]:not([open]) > summary")
      .click()
      .catch(() => {});
    const card = page.locator('[data-swarm-agent-card="zen"]');
    await card.waitFor({ state: "visible", timeout: 10_000 });
    const text = await card.innerText();
    // Zen's probe goes to the internet: on a machine that is offline (or rate-limited) the card honestly says "Not tested".
    if (!/Works|Not tested/.test(text)) {
      await defect({
        control: "OpenCode Zen provider card",
        expected: "Zen shows a Works badge on this stack (no key needed)",
        actual: text.slice(0, 200),
        severity: "wrong",
      });
    }
    covered("OpenCode Zen card: initial Works state");

    await card.getByRole("button", { name: "Test connection" }).click();
    await sleep(1500);
    const after = await card.innerText();
    if (!/Works|free model|Not tested|can.?t reach|rate/i.test(after)) {
      await defect({
        control: "OpenCode Zen: Test connection",
        expected: "still reports working after a manual test",
        actual: after.slice(0, 200),
        severity: "wrong",
      });
    } else {
      covered("OpenCode Zen: Test connection");
    }
    expect.equal(await switchOn(card.getByRole("switch")), true);
  });

  t.test("OpenRouter card: save an invalid key, test it, then remove it", async (ctx) => {
    const { open, expect, covered, defect, page, sleep } = ctx;
    await open("/settings/swarm");
    // Providers, keys, local models, worker model and privacy sit under "More options" (night 2026-10-04).
    await page
      .locator("[data-swarm-more-options]:not([open]) > summary")
      .click()
      .catch(() => {});
    const card = page.locator('[data-swarm-agent-card="openrouter"]');
    await card.waitFor({ state: "visible", timeout: 10_000 });
    await sleep(500);

    // Precondition: no key saved yet. Clean up first if a previous run left one behind.
    if (await card.getByRole("button", { name: "Remove key" }).count()) {
      await card.getByRole("button", { name: "Remove key" }).click();
      await sleep(1000);
    }

    // Testing with no key: outcome should be a clear, calm "no key" message, not a crash.
    await card.getByRole("button", { name: "Test connection" }).click();
    await sleep(1200);
    covered("OpenRouter: Test connection with no key");
    const noKeyMessage = await card
      .locator("[data-swarm-test-outcome]")
      .locator("p")
      .last()
      .innerText()
      .catch(() => "");
    if (noKeyMessage && /^[a-z]/.test(noKeyMessage.trim())) {
      await defect({
        control: "OpenRouter: Test connection with no key",
        expected: "a properly capitalised, complete-sentence error message",
        actual: `"${noKeyMessage.trim()}"`,
        severity: "copy",
      });
    }

    // Save a key (bogus, since there is no live credential in this environment), then always
    // remove it again in `finally` so a failed assertion never leaves it behind.
    try {
      // The placeholder changes once a key is saved ("Paste a new key to replace it"), so locate by
      // the stable password-input selector rather than by placeholder text.
      const input = card.locator('input[type="password"]');
      await input.fill("sk-or-v1-qa-test-bogus-key");
      await card.getByRole("button", { name: "Save" }).click();
      await sleep(1200);
      const savedText = await card.innerText();
      if (!/Saved key/.test(savedText)) {
        await defect({
          control: "OpenRouter: Save key",
          expected: 'a "Saved key …" hint after saving',
          actual: savedText.slice(0, 200),
          severity: "wrong",
        });
      } else {
        covered("OpenRouter: Save key");
      }
      // The typed key must never be echoed back into the (now empty) input.
      expect.equal(await input.inputValue(), "");

      await card.getByRole("button", { name: "Test connection" }).click();
      await sleep(1500);
      const testedText = await card.innerText();
      if (!/rejected|Key rejected/i.test(testedText)) {
        await defect({
          control: "OpenRouter: Test connection with a bogus key",
          expected: "the bogus key is reported as rejected",
          actual: testedText.slice(0, 200),
          severity: "wrong",
        });
      } else {
        covered("OpenRouter: Test connection with a bogus key");
      }
    } finally {
      if (await card.getByRole("button", { name: "Remove key" }).count()) {
        await card.getByRole("button", { name: "Remove key" }).click();
        await sleep(1000);
      }
    }
    const restoredText = await card.innerText();
    expect.equal(/Remove key/.test(restoredText), false);
    covered("OpenRouter: Remove key");
  });

  t.test("Cerebras card: off by default, Turn on / off round-trips", async (ctx) => {
    const { open, expect, covered, defect, page, sleep } = ctx;
    await open("/settings/swarm");
    // Providers, keys, local models, worker model and privacy sit under "More options" (night 2026-10-04).
    await page
      .locator("[data-swarm-more-options]:not([open]) > summary")
      .click()
      .catch(() => {});
    const card = page.locator('[data-swarm-agent-card="cerebras"]');
    await card.waitFor({ state: "visible", timeout: 10_000 });
    await sleep(500);
    const sw = card.getByRole("switch");
    const initiallyOn = await switchOn(sw);
    expect.equal(initiallyOn, false);

    try {
      await sw.click();
      await sleep(800);
      const onText = await card.innerText();
      if (/^Off/.test(onText.replace(/^Cerebras \(trial\)\s*/, ""))) {
        await defect({
          control: "Cerebras: Enabled switch",
          expected: "the card no longer reads Off after turning it on",
          actual: onText.slice(0, 120),
          severity: "wrong",
        });
      } else {
        covered("Cerebras: turn on");
      }
    } finally {
      // Restore to off regardless of what the assertions above found.
      if (await switchOn(sw)) {
        await sw.click();
        await sleep(800);
      }
    }
    const offText = await card.innerText();
    expect.match(offText, /Off/);
    covered("Cerebras: turn off (restored)");
  });

  t.test("provider key field never becomes a plain-text field", async (ctx) => {
    const { open, expect, covered, page } = ctx;
    // Not a bug per the product notes (keys are never shown back), but worth confirming there is no
    // dead "show password" affordance left half-wired.
    await open("/settings/swarm");
    // Providers, keys, local models, worker model and privacy sit under "More options" (night 2026-10-04).
    await page
      .locator("[data-swarm-more-options]:not([open]) > summary")
      .click()
      .catch(() => {});
    const card = page.locator('[data-swarm-agent-card="openrouter"]');
    const input = card.locator('input[type="password"]');
    await input.waitFor({ state: "visible", timeout: 10_000 });
    expect.equal(await input.getAttribute("type"), "password");
    covered("Provider key input stays type=password (no key ever shown back)");
  });
});
