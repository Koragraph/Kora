// 06-timeline: the auth-failure error (expected in this environment — no model credentials), shown once, and the
// mode-notice divider row. Mutates only [a06] chat one / chat three,
// both dedicated to this area; sent messages cannot be un-sent, so reruns just add more
// (expected) failed turns to these namespaced threads.
import { spec } from "../lib/harness.mjs";

const STACK = 2;

spec("06-timeline", { stack: STACK }, async (t) => {
  // B3 (night 2026-10-04): the signed-out error showed twice — a red banner AND Claude's own reply under it. It now
  // shows once, in the reply, with the actions (Log in to Claude where the daemon can run it, Retry, Details).
  t.test(
    "auth failure shows once (in the reply, no banner) with a Sign in action, composer stays usable",
    async (ctx) => {
      const { page, open, seed, expect, covered, step } = ctx;
      await open("/");
      const fixture = seed().threads.find((th) => th.title === "[a06] chat one");
      await page.getByText("tiny-lib").first().click();
      await page.getByText(fixture.title).first().click();
      await page.waitForTimeout(1000);

      const composer = page.locator('[contenteditable="true"]').first();
      await composer.click();
      const nonce = `qa-06-timeline ${Date.now()}`;
      await page.keyboard.type(`[stub:authfail] ${nonce}`);
      step("send; the stub engine answers like a signed-out Claude CLI");
      await page.getByLabel("Send message").click();

      // A signed-out Claude gets the Sign in action in the reply (a Retry would only fail the same way).
      const signIn = page.getByRole("button", { name: "Sign in to Claude" }).last();
      await signIn.waitFor({ timeout: 15_000 });
      // Reruns leave older failed turns in this thread: only the banner must be gone, the reply carries the error.
      expect.ok(
        (await page.getByText("Claude isn't signed in").count()) >= 1,
        "the reply says why",
      );
      expect.equal(
        await page.locator('[data-variant="error"]').count(),
        0,
        "no banner repeating the reply",
      );
      covered("error: shown once, inline, on auth failure");

      // Composer must be usable (not stuck disabled/spinning).
      await composer.click();
      await page.keyboard.type("x");
      const typed = await composer.innerText();
      expect.ok(typed.includes("x"), "expected the composer to accept input after the error");
      await page.keyboard.press("Meta+A");
      await page.keyboard.press("Backspace");
      covered("error: composer usable again after failure");
    },
    { control: "Inline agent error", severity: "wrong", allowNetwork: [/\/api\/.*|.*ws.*/] },
  );

  t.test(
    "mode-notice divider row renders after flipping Swarm and sending",
    async (ctx) => {
      const { page, open, seed, expect, covered, step, defect } = ctx;
      await open("/");
      const fixture = seed().threads.find((th) => th.title === "[a06] chat three");
      await page.getByText("dirty-app").first().click();
      await page.getByText(fixture.title).first().click();
      await page.waitForTimeout(1000);

      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      // A notice is owed whenever Swarm flips (on or off): the agent must hear it changed.
      const toggle = page.locator("[data-prompt-swarm]");
      await toggle.waitFor({ timeout: 10_000 });
      const wasOn = (await toggle.getAttribute("aria-pressed")) === "true";
      step(`Swarm was ${wasOn ? "on" : "off"}, switching it ${wasOn ? "off" : "on"}`);
      await toggle.click();
      await page.waitForTimeout(500);

      const composer = page.locator('[contenteditable="true"]').first();
      await composer.click();
      await page.keyboard.type(`qa-06-timeline mode switch ${Date.now()}`);
      await page.getByLabel("Send message").click();
      await page.waitForTimeout(2500);

      // The switch shows at toggle time as an activity divider ("Stretch on", or "Switched from X to Y" between other modes); the notice only
      // becomes a user-message row when Kora sends it on its own (flushPending) — the spec predates that split.
      const divider = page.getByText(/^(Switched from \w+ to \w+|Stretch (on|off))$/).last();
      const noticeRow = page.locator('[data-transcript-row-kind="mode-notice"]').last();
      const notice = (await noticeRow.count()) > 0 ? noticeRow : divider;
      const appeared = (await notice.count()) > 0;
      if (!appeared) {
        await defect({
          control: "Mode-notice divider row (agent-mode-switched)",
          page: "[a06] chat three",
          expected:
            "flipping Swarm and sending a message renders a mode-notice divider row in the timeline",
          actual: "no [data-transcript-row-kind=mode-notice] row found after switching and sending",
          severity: "broken",
        });
      } else {
        const noticeText = await notice.innerText();
        expect.ok(/Switched/i.test(noticeText), "expected the notice to mention the switch");
        covered("mode-notice divider row: renders on agent-mode-switched", noticeText.slice(0, 80));
      }
    },
    { control: "Mode-notice divider row", severity: "broken", allowNetwork: [/\/api\/.*|.*ws.*/] },
  );

  t.test("ink palette across [a06] chat one after the error banner", async (ctx) => {
    const { page, open, seed, inkCheck, covered, defect } = ctx;
    await open("/");
    const fixture = seed().threads.find((th) => th.title === "[a06] chat one");
    await page.getByText("tiny-lib").first().click();
    await page.getByText(fixture.title).first().click();
    await page.waitForTimeout(1200);
    const hits = await inkCheck();
    const bad = hits.filter((h) => h.kind === "cold");
    if (bad.length > 0) {
      await defect({
        control: "Ink palette ([a06] chat one)",
        expected: "no cold (blue/cyan/violet) colors on the page",
        actual: JSON.stringify(bad.slice(0, 5)),
        severity: "visual",
      });
    }
    covered("ink palette check: [a06] chat one", `${hits.length} hue hit(s)`);
  });
});
