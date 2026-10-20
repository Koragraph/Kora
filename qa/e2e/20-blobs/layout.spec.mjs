// 20-blobs: the blob's side panel docks beside the chat from 1100 px wide and overlays it as a sheet below that (at 900 px a docked panel
// squeezed the chat to ~260 px and clipped the header, live QA #3); the chat column keeps >= 420 px when docked; the header never
// clips its model chip. No model is called.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spec } from "../lib/harness.mjs";
import { STACK, createBlob, openPanel } from "./blobUi.mjs";

const ASSETS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/bots/assets",
);
const NAME = `Lay${Date.now().toString(36).slice(-4)}`;
const shot = async (page, name) => {
  fs.mkdirSync(ASSETS, { recursive: true });
  await page.screenshot({ path: path.join(ASSETS, name) });
};

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "from 1100 px the Profile panel docks beside the chat (chat >= 420 px, never covered); below 1100 it is a sheet over a full-width chat; the header never clips",
    async ({ page, open, sleep, expect, covered }) => {
      const blob = await createBlob(page, open, NAME);
      await page.setViewportSize({ width: 1200, height: 800 });
      await openPanel(page, open, blob.id, "profile");
      await sleep(900);
      const panel = await page.locator("[data-blob-panel-tabbar]").boundingBox();
      const composer = await page.locator('[contenteditable="true"]').last().boundingBox();
      expect.ok(panel && composer, "both are on screen");
      expect.ok(
        composer.x + composer.width <= panel.x + 2,
        `docked: the composer (${composer.x}+${composer.width}) ends where the panel (${panel.x}) starts`,
      );
      expect.ok(
        composer.width >= 420,
        `the chat keeps at least 420 px beside the panel (has ${composer.width})`,
      );
      await shot(page, "f3-layout-1200-docked.png");
      covered("Layout > docked at 1200 px, chat >= 420");

      for (const width of [1000, 900]) {
        await page.setViewportSize({ width, height: 800 });
        await sleep(900);
        const sheet = await page.locator("[data-blob-panel-tabbar]").boundingBox();
        const box = await page.locator('[contenteditable="true"]').last().boundingBox();
        expect.ok(box, "the composer is there");
        // the chat is NOT squeezed: its composer is wide, and the panel (a sheet) lies over it rather than pushing it
        expect.ok(
          box.width >= 420,
          `at ${width} px the chat keeps its width (composer ${box.width})`,
        );
        if (sheet)
          expect.ok(
            box.x + box.width > sheet.x,
            `at ${width} px the panel is a sheet over the chat, not docked beside it`,
          );
        // header: nothing wider than the window, the model chip shows its whole label
        const clipped = await page.evaluate((w) => {
          const bad = [];
          for (const el of document.querySelectorAll(
            "header *, [data-blob-header-identity], [data-blob-panel-toggle]",
          )) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.right > w + 1)
              bad.push(`${el.tagName} right=${Math.round(r.right)}`);
          }
          return bad.slice(0, 5);
        }, width);
        expect.equal(
          clipped.length,
          0,
          `nothing in the header runs off the ${width} px window: ${clipped.join(", ")}`,
        );
        await shot(page, `f3-layout-${width}-sheet.png`);
      }
      covered("Layout > sheet below 1100 px, header not clipped");
    },
    { control: "Layout > panel dock threshold", severity: "wrong" },
  );
});
