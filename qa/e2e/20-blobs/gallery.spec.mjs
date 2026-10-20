// 20-blobs: Kora's welcome, the starter gallery and the hire fly-in, in the REAL app: the wired first-run on Kora's empty
// thread, the daemon's templates / hire RPCs, the HireFlyInLayer mounted at the root, the roster rows the blobs land on.
// No model is called. Expects a stack where Kora has no messages yet (the suite resets the stack before it runs); the
// tests reset the `galleryDismissed` flag themselves (it is a plain file in the stack's home).
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spec } from "../lib/harness.mjs";
import { loadBlob } from "./blobSeed.mjs";

const { stack: stackEnv } = createRequire(import.meta.url)("../../stacks/env.cjs");
const STACK = Number(process.env.KORA_QA_BLOBS_STACK ?? 2);
const settingsFile = () => path.join(stackEnv(STACK).home, "blobs", "_settings.json");
const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/bots/assets");
const resetDismissed = () => fs.rmSync(settingsFile(), { force: true });

/** Kora's empty thread: where the landing sends a brand-new team, or her sidebar "New thread" when she has history. */
async function openKoraEmpty(page, open) {
  await open("/blobs", { wait: false });
  await page.locator("[data-blobs-roster]").waitFor({ state: "attached", timeout: 60_000 }); // hidden at phone width
  const welcome = page.locator("[data-kora-welcome]");
  if (
    await welcome.waitFor({ timeout: 12_000 }).then(
      () => true,
      () => false,
    )
  )
    return;
  // dispatchEvent: the sidebar is collapsed at phone width, but its button still works
  await page
    .locator("[data-blobs-roster] button", { hasText: "New thread" })
    .first()
    .dispatchEvent("click");
  await welcome.waitFor({ timeout: 30_000 });
}

spec("20-blobs-gallery", { stack: STACK }, async (t) => {
  t.test(
    "Kora's welcome shows on her empty thread: intro, still sprite, two actions, direct-message hint; Browse opens the daemon's ten starters",
    async ({ page, open, sleep, expect, inkCheck }) => {
      resetDismissed();
      await openKoraEmpty(page, open);
      const text = await page.locator("[data-kora-welcome]").innerText();
      expect.ok(text.includes("I’m Kora."));
      expect.ok(text.includes("I run your team of blobs"));
      expect.ok(text.includes("message any blob directly"));
      // Content-area sprites are still by design (commit 542cc238): the welcome shows Kora's static frame, no wave.
      expect.equal(
        await page.locator("[data-kora-welcome-avatar]").count(),
        1,
        "Kora's welcome avatar is shown",
      );
      expect.equal(
        await page.locator("[data-kora-welcome-avatar] [data-reaction]").count(),
        0,
        "the welcome sprite is a still frame (no wave or other reaction)",
      );
      expect.equal(
        await page.locator("[data-kora-first-run-gate]").count(),
        1,
        "mounted by the real thread view, not a preview page",
      );
      // Live QA #2: the welcome used to cover the composer, and the "new chat" hero composer showed beneath it
      const composer = page.locator('[contenteditable="true"]').last();
      expect.equal(await composer.isVisible(), true, "the composer is visible beside the welcome");
      const welcomeBox = await page.locator("[data-kora-welcome]").boundingBox();
      const composerBox = await composer.boundingBox();
      expect.ok(
        welcomeBox.y + welcomeBox.height <= composerBox.y + 1,
        `the welcome ends above the composer (${welcomeBox.y + welcomeBox.height} vs ${composerBox.y})`,
      );
      expect.equal(
        await page.locator("[data-kora-first-run-gate] [contenteditable]").count(),
        0,
        "no second composer under the welcome",
      );
      fs.mkdirSync(ASSETS, { recursive: true });
      await sleep(2200); // the welcome's entrance animation
      await page.screenshot({ path: path.join(ASSETS, "f2-welcome-composer.png") });
      await composer.click();
      await page.keyboard.type("a question typed beside the welcome");
      expect.ok((await composer.innerText()).includes("a question typed"), "and you can type");
      await page.keyboard.press("Meta+a");
      await page.keyboard.press("Backspace");
      const cold = (await inkCheck({ root: "[data-kora-welcome]" })).filter(
        (h) => h.kind === "cold",
      );
      expect.equal(cold.length, 0);
      await page.locator("[data-welcome-browse]").click();
      await page.locator("[data-starter-gallery]").waitFor();
      await page.locator("[data-template-card]").first().waitFor({ timeout: 20_000 });
      await sleep(300);
      expect.equal(await page.locator("[data-template-card]").count(), 10);
      await sleep(1600); // the cards fade in one by one
      await page.screenshot({ path: path.join(ASSETS, "f2-gallery.png") });
      // every card in a row is as tall as its tallest neighbour, and a starter's routine is mentioned on its card
      const heights = await page
        .locator("[data-template-card]")
        .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      expect.ok(
        heights.slice(0, 3).every((h) => h === heights[0]),
        `the first row is even: ${heights.slice(0, 3)}`,
      );
      expect.ok(
        (await page.locator("[data-template-card='popo']").innerText()).includes("Suggested routine"),
        "Popo says it brings a (paused) routine",
      );
      const names = (await page.locator("[data-template-card]").allInnerTexts()).join("|");
      for (const n of [
        "Popo",
        "Bobble",
        "Dimp",
        "Junip",
        "Wobbo",
        "Tibbo",
        "Mibble",
        "Zonk",
        "Plonk",
        "Fizzle",
      ])
        expect.ok(names.includes(n), `${n} is in the gallery`);
    },
    { control: "Blobs › Kora welcome (wired)", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "gallery: select several (keyboard too), Hire N blobs for real, cards say On the team, blobs fly to their sidebar rows, the grid does not jump",
    async ({ page, open, sleep, expect }) => {
      resetDismissed();
      await openKoraEmpty(page, open);
      await page.locator("[data-welcome-browse]").click();
      await page.locator("[data-template-card]").first().waitFor({ timeout: 20_000 });
      expect.equal(await page.locator("[data-hire-bar]").count(), 0);
      await page.locator("[data-template-select='popo']").focus();
      await page.keyboard.press("Space");
      expect.equal(
        await page.locator("[data-template-select='popo']").getAttribute("aria-checked"),
        "true",
      );
      await page.locator("[data-template-select='popo']").click(); // unselect again
      await page.locator("[data-template-select='junip']").click();
      await page.locator("[data-template-select='wobbo']").click();
      expect.equal((await page.locator("[data-hire-selected]").innerText()).trim(), "Hire 2 blobs");
      // the hire bar slides in; clicking it mid-slide makes Playwright retry with other scroll alignments (an artefact of the
      // driver: a person never scrolls the grid by pressing Hire), so let it settle first
      await sleep(900);
      const gridTop = (await page.locator("[data-gallery-grid]").boundingBox()).y;
      await page.evaluate(() => {
        window.__blobFlew = false;
        new MutationObserver(() => {
          if (document.querySelector("[data-hire-fly]")) window.__blobFlew = true;
        }).observe(document.body, { childList: true, subtree: true });
      });
      await page.locator("[data-hire-selected]").click();
      await page
        .locator("[data-template-card='wobbo'][data-hired='true']")
        .waitFor({ timeout: 20_000 });
      await sleep(1200);
      expect.ok(
        await page.evaluate(() => window.__blobFlew === true),
        "a blob flew (the layer is mounted at the app root)",
      );
      for (let i = 0; i < 40 && (await page.locator("[data-hire-fly]").count()) > 0; i += 1)
        await sleep(150);
      expect.equal(await page.locator("[data-hire-fly]").count(), 0, "flights land and clear");
      for (const id of ["junip", "wobbo"]) {
        const card = page.locator(`[data-template-card='${id}']`);
        expect.equal(await card.getAttribute("data-hired"), "true");
        expect.ok((await card.innerText()).includes("On the team"));
      }
      expect.ok((await page.locator("[data-kora-hire-line]").innerText()).includes("on the team"));
      // the line floats over the canvas: the grid stayed exactly where it was (it used to drop ~84px)
      const gridAfter = (await page.locator("[data-gallery-grid]").boundingBox()).y;
      expect.ok(Math.abs(gridAfter - gridTop) <= 1, `grid moved ${gridAfter - gridTop}px`);
      // the daemon really hired them: profiles on disk from the templates, in the sidebar roster
      for (const [id, name] of [
        ["junip", "Junip"],
        ["wobbo", "Wobbo"],
      ]) {
        const profile = loadBlob(STACK, name);
        expect.equal(profile.templateId, id);
        expect.ok(
          fs.existsSync(path.join(profile.workspace, "outputs")),
          `${name}'s folder exists`,
        );
        await page
          .locator(`[data-blobs-roster] [data-blob-id='${profile.id}']`)
          .first()
          .waitFor({ timeout: 15_000 });
      }
    },
    { control: "Blobs › gallery hire + fly-in (wired)", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "reduced motion: hiring still completes with no flight animation left behind",
    async ({ page, open, sleep, expect }) => {
      resetDismissed();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openKoraEmpty(page, open);
      await page.locator("[data-welcome-browse]").click();
      await page.locator("[data-template-hire='dimp']").waitFor({ timeout: 30_000 });
      await page.locator("[data-template-hire='dimp']").click();
      await sleep(1800);
      expect.equal(
        await page.locator("[data-template-card='dimp']").getAttribute("data-hired"),
        "true",
      );
      expect.equal(await page.locator("[data-hire-fly]").count(), 0);
      expect.equal(loadBlob(STACK, "Dimp").templateId, "dimp");
    },
    { control: "Blobs › gallery reduced motion (wired)", severity: "visual", ignoreErrors: true },
  );

  t.test(
    "gallery is responsive: no horizontal scroll at phone width",
    async ({ page, open, expect }) => {
      resetDismissed();
      await page.setViewportSize({ width: 420, height: 800 });
      await openKoraEmpty(page, open);
      await page.locator("[data-welcome-browse]").click();
      await page.locator("[data-template-card]").first().waitFor({ timeout: 30_000 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
    },
    { control: "Blobs › gallery responsive (wired)", severity: "visual", ignoreErrors: true },
  );

  t.test(
    "Build me a blob: closes the welcome for good and starts the composer with the request",
    async ({ page, open, sleep, expect }) => {
      resetDismissed();
      await openKoraEmpty(page, open);
      await page.locator("[data-welcome-build]").click();
      await page
        .locator("[data-kora-first-run-gate]")
        .waitFor({ state: "detached", timeout: 10_000 });
      await sleep(300);
      const editor = page.locator('[contenteditable="true"]').first();
      expect.ok(
        (await editor.innerText()).includes("Build me a blob that"),
        "the composer holds the starter text",
      );
      const flags = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
      expect.equal(flags.galleryDismissed, true, "the daemon remembers it");
    },
    { control: "Blobs › Build me a blob (wired)", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "Maybe later dismisses the gallery; it stays gone after a reload; the normal chat shows",
    async ({ page, open, sleep, expect }) => {
      resetDismissed();
      await openKoraEmpty(page, open);
      await page.locator("[data-welcome-browse]").click();
      await page.locator("[data-gallery-close]").click();
      await page
        .locator("[data-kora-first-run-gate]")
        .waitFor({ state: "detached", timeout: 10_000 });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 60_000 });
      await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 30_000 });
      await sleep(1500);
      expect.equal(
        await page.locator("[data-kora-first-run-gate]").count(),
        0,
        "not back after a reload",
      );
      expect.equal(JSON.parse(fs.readFileSync(settingsFile(), "utf8")).galleryDismissed, true);
    },
    { control: "Blobs › gallery dismiss (wired)", severity: "wrong", ignoreErrors: true },
  );
});
