// 20-blobs: the Blobs transcript skin and its cards, on a thread seeded with real memory receipts (blobSeed.mjs).
// No model is called: the thread, its activities and the memory db are written to the stack while the daemon is down.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spec } from "../lib/harness.mjs";
import { loadBlob, seedBlobScenario, serveBlobFiles } from "./blobSeed.mjs";

const ASSETS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/bots/assets",
);
const STACK = Number(process.env.KORA_QA_BLOBS_STACK ?? 2);
let scenario = null;

// The transcript is virtualized: a row far from the viewport is not in the DOM. Scroll toward `locator` until it is.
async function reveal(page, locator) {
  await page.mouse.move(900, 500);
  for (const direction of [-1, 1]) {
    for (let i = 0; i < 12; i += 1) {
      if ((await locator.count()) > 0) {
        await locator.first().scrollIntoViewIfNeeded();
        return locator.first();
      }
      await page.mouse.wheel(0, direction * 600);
      await page.waitForTimeout(250);
    }
  }
  throw new Error(`could not scroll to ${locator}`);
}

async function openSeededThread(page, open, sleep) {
  await serveBlobFiles(page, scenario.blob.workspace);
  // Kora (the Chief) is the landing blob now, so go straight to the seeded thread of the blob under test.
  await open(`/kora-local/${scenario.threadId}`, { wait: false });
  await page.locator("[data-blob-bubble='assistant']").first().waitFor({ timeout: 30_000 });
  await sleep(800);
}

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "set up: a blob with a seeded conversation",
    async ({ page, open, sleep }) => {
      await open("/blobs", { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 60_000 });
      await sleep(1500);
      let exists = true;
      try {
        loadBlob(STACK, "Popo");
      } catch {
        exists = false;
      }
      if (!exists) {
        await page.locator("[data-new-blob], [data-blobs-empty] button").first().click();
        await page.locator("[data-blob-editor]").waitFor();
        await page.getByLabel("Name", { exact: true }).fill("Popo");
        await page.locator("[data-editor-save]").click();
        // The blob's profile lands on disk before the roster repaints; wait on the disk, which is what seeding needs.
        for (let i = 0; i < 60; i += 1) {
          try {
            loadBlob(STACK, "Popo");
            break;
          } catch {
            await sleep(500);
          }
        }
      }
      scenario = await seedBlobScenario(STACK, "Popo");
    },
    { control: "Blobs › transcript seed", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "replies are left bubbles with the blob's avatar once per burst; messages from you are right bubbles",
    async ({ page, open, sleep, expect, covered }) => {
      await openSeededThread(page, open, sleep);
      const bubbles = page.locator("[data-blob-bubble='assistant']");
      expect.ok((await bubbles.count()) >= 3, "the seeded replies should render as bubbles");
      // The first reply of a burst carries the avatar; the gutter exists on every reply row.
      expect.ok((await page.locator("[data-blob-gutter='avatar']").count()) >= 1);
      // Table + code render inside the bubble, not outside it.
      const long = bubbles.filter({ hasText: "Three units fit" });
      expect.equal(await long.locator("table").count(), 1);
      expect.ok((await long.locator("pre, code").count()) >= 1);
      // A reading width, not a giant bubble.
      const box = await long.first().boundingBox();
      expect.ok(box && box.width <= 660, `bubble should stay under ~40rem, got ${box?.width}`);
      covered("Blobs › bubbles + avatar gutter");
    },
    { control: "Blobs › bubbles", severity: "broken", allowNetwork: [/api\/blobs/] },
  );

  t.test(
    "memory receipts sit between bubbles as one quiet line each; Undo calls the daemon and shows Undone",
    async ({ page, open, sleep, expect, covered }) => {
      await openSeededThread(page, open, sleep);
      const receipt = page
        .locator("[data-blob-card='memory-added']")
        .filter({ hasText: "You live in Dallas" });
      await reveal(page, receipt);
      expect.ok((await receipt.count()) >= 1, "the Dallas receipt should be on the page");
      const height = (await receipt.first().boundingBox())?.height ?? 999;
      expect.ok(height < 40, `a receipt is one line, got ${height}px`);
      await receipt.first().getByRole("button", { name: "Undo" }).click();
      await page
        .locator("[data-blob-card='memory-undone']")
        .filter({ hasText: "You live in Dallas" })
        .first()
        .waitFor({ timeout: 15_000 });
      covered("Blobs › memory receipt Undo");
    },
    { control: "Blobs › memory receipt", severity: "broken", allowNetwork: [/api\/blobs/] },
  );

  t.test(
    "a held memory asks first; the rate-limit and self-change cards render",
    async ({ page, open, sleep, expect, covered }) => {
      await openSeededThread(page, open, sleep);
      const held = page.locator("[data-blob-card='memory-held']").filter({ hasText: "caffeine" });
      await reveal(page, held);
      await held.first().getByRole("button", { name: "Approve" }).waitFor();
      await held.first().getByRole("button", { name: "Not this" }).waitFor();
      const limit = page.locator("[data-blob-card='rate-limit']");
      await reveal(page, limit);
      expect.ok((await limit.innerText()).includes("Claude is at its limit"));
      await limit.getByRole("button", { name: "Continue on a free model" }).waitFor();
      const change = page.locator("[data-blob-card='self-change']");
      await reveal(page, change);
      await change.getByRole("button", { name: "Details" }).click();
      expect.ok((await page.getByText("Applies from the next conversation").count()) >= 1);
      covered("Blobs › held / rate-limit / self-change cards");
    },
    { control: "Blobs › cards", severity: "broken", allowNetwork: [/api\/blobs/] },
  );

  t.test(
    "output cards: a spreadsheet shows a real table with sheet tabs; csv, deck and document cards read the file",
    async ({ page, open, sleep, expect, covered }) => {
      await openSeededThread(page, open, sleep);
      const sheet = page.locator("[data-blob-output-card='sheet']");
      await reveal(page, sheet);
      await sheet.locator("[data-sheet-table]").waitFor({ timeout: 20_000 });
      expect.ok((await sheet.locator("th").count()) >= 4);
      await sheet.getByRole("tab", { name: "Install costs" }).click();
      await sheet.getByText("Electrician visit").waitFor();
      await sheet.getByRole("button", { name: "Expand preview" }).click();
      await sheet.getByRole("tab", { name: "Comparison" }).click();
      await sheet.getByText("Archived model 1", { exact: true }).waitFor();
      const csv = page.locator("[data-blob-output-card='delimited']");
      await reveal(page, csv);
      await csv.getByText("Existing breaker").waitFor({ timeout: 20_000 });
      const deck = page.locator("[data-blob-output-card='slides']");
      await reveal(page, deck);
      await deck.getByText("4 slides").waitFor({ timeout: 20_000 });
      // the first slide as the file really looks (macOS Quick Look in the daemon), not only a text excerpt
      await deck.locator("[data-first-page]").waitFor({ timeout: 30_000 });
      expect.equal(
        await deck.locator("[data-first-page]").getAttribute("data-first-page"),
        "slides",
      );
      await deck.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await sleep(700);
      fs.mkdirSync(ASSETS, { recursive: true });
      await page.screenshot({ path: path.join(ASSETS, "f2-transcript-previews.png") });
      await deck.screenshot({ path: path.join(ASSETS, "f2-pptx-preview.png") });
      const doc = page.locator("[data-blob-output-card='document']");
      await reveal(page, doc);
      await doc.getByText("3 pages").waitFor({ timeout: 20_000 });
      await doc.locator("[data-first-page]").waitFor({ timeout: 30_000 });
      await doc.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await sleep(500);
      await doc.screenshot({ path: path.join(ASSETS, "f2-docx-preview.png") });
      covered("Blobs › output cards (sheet, csv, deck, document)");
    },
    { control: "Blobs › output cards", severity: "broken", allowNetwork: [/api\/blobs/] },
  );

  t.test(
    "the skin stays in Ink: no cold or accent colours in the transcript",
    async ({ page, open, sleep, inkCheck, expect }) => {
      await openSeededThread(page, open, sleep);
      // Code-block syntax tokens (existing highlighter, purple keywords) are not part of the skin.
      const cold = (await inkCheck({ root: "main" })).filter(
        (h) => h.kind === "cold" && !h.element.startsWith("span"),
      );
      expect.equal(cold.length, 0, `cold colours: ${JSON.stringify(cold)}`);
    },
    { control: "Blobs › transcript ink", severity: "visual", allowNetwork: [/api\/blobs/] },
  );
});
