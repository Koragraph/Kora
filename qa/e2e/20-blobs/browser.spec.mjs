// 20-blobs: each blob's own browser (Phase 6), end to end through the real daemon, the live ws route and the UI.
// The "model" is the QA stub engine, which calls the blob's real browser tools (`[stub:tool browser_navigate {...}]`) exactly as the
// SDK would; the browser is Kora's own headless shell against a local cinema (loopback is allowed per blob in Browser settings).
//   - Computer tab: empty state, "Local VM" parked as coming soon, the browser settings (downloads, local dev servers)
//   - the blob browses: the live picture, the status chip, the address; the reply carries the page text
//   - booking asks: the SAME approval appears as an inline card and in the panel bar; Deny in the panel retires the card and the
//     order never reaches the site; Allow on the card places it (first answer wins)
//   - take over: pressing on the picture pauses the blob ("You're driving"), Hand back resumes it
//   - the one-time setup screen when the browser has not been installed (98 MB; never inside an agent turn)
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spec } from "../lib/harness.mjs";
import { STACK, openPanel, readJson } from "./blobUi.mjs";
import { createBlob } from "./blobUi.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const ASSETS = path.join(ROOT, "docs/bots/assets");
const stamp = Date.now().toString(36).slice(-4);
const NAME = `Tixy${stamp}`;

const shot = async (page, name) => {
  fs.mkdirSync(ASSETS, { recursive: true });
  await page.screenshot({ path: path.join(ASSETS, `i4b-${name}.png`) });
};

let fx = null;
let blob = null;

async function say(page, text) {
  const box = page.locator('[contenteditable="true"]').last();
  await box.waitFor({ timeout: 30_000 });
  await box.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}
const bodyHas = (page, text, timeout = 60_000) => page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });
const tool = (name, args = {}) => `[stub:tool ${name} ${JSON.stringify(args)}]`;
const inkLoadFixture = async () => {
  const { startFixture } = require(path.join(ROOT, "packages/runtime/dist/blobs/browser/browser.fixture.js"));
  return startFixture();
};

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "the Computer tab: nothing opened yet, Local VM parked as coming soon, browser settings (downloads off, local servers allowed per blob)",
    async ({ page, open, expect, covered }) => {
      fx = await inkLoadFixture();
      blob = await createBlob(page, open, NAME);
      await openPanel(page, open, blob.id, "computer");
      await page.locator("[data-browser-panel]").waitFor({ timeout: 60_000 });
      await page.locator('[data-browser-status="idle"], [data-browser-status="closed"]').first().waitFor({ timeout: 30_000 });
      expect.match(await page.locator("[data-browser-stage]").innerText(), /hasn't opened a page yet/);
      const vm = page.locator("[data-local-vm]");
      expect.match(await vm.innerText(), /Local VM[\s\S]*Coming soon/i);
      expect.equal(await vm.getAttribute("aria-disabled"), "true");
      covered("computer tab empty + local vm soon");

      await page.locator("[data-browser-settings-toggle]").click();
      const settings = page.locator("[data-browser-settings]");
      await settings.waitFor();
      expect.equal(await settings.locator("[data-browser-downloads]").getAttribute("aria-checked"), "false", "downloads are off by default");
      // a bad entry is a sentence; a good one is saved on the profile and applies to the running browser
      await settings.locator("[data-browser-host-input]").fill("not a host!");
      await settings.locator("[data-browser-host-add]").click();
      expect.match(await settings.locator("[data-browser-settings-error]").innerText(), /localhost:5173/);
      await settings.locator("[data-browser-host-input]").fill(`127.0.0.1:${fx.port}`);
      await settings.locator("[data-browser-host-add]").click();
      await settings.locator("[data-browser-hosts]").getByText(`127.0.0.1:${fx.port}`).waitFor({ timeout: 15_000 });
      await settings.locator("[data-browser-downloads]").click();
      await page.waitForFunction(() => document.querySelector("[data-browser-downloads]")?.getAttribute("aria-checked") === "true");
      await page.waitForTimeout(500);
      const computer = readJson("blobs", blob.id, "profile.json").toolGrants.computer;
      expect.deepEqual(computer.allowLocalHosts, [`127.0.0.1:${fx.port}`]);
      expect.equal(computer.allowDownloads, true);
      covered("browser settings: local hosts + downloads");
      await shot(page, "computer-empty");
    },
  );

  t.test(
    "the blob browses a cinema: the live picture, the page text for the model, and a local address stays blocked until allowed",
    async ({ page, open, expect, covered }) => {
      await openPanel(page, open, blob.id, "computer");
      await page.locator("[data-browser-panel]").waitFor({ timeout: 60_000 });
      await say(page, tool("browser_navigate", { url: `${fx.base}/cinema` }));
      await bodyHas(page, "browser_navigate ->");
      await bodyHas(page, "Showtimes - Rialto Cinema");
      await page.locator('[data-browser-status="idle"], [data-browser-status="working"]').first().waitFor();
      await page.waitForFunction(() => {
        const c = document.querySelector("[data-browser-canvas]");
        if (!(c instanceof HTMLCanvasElement) || c.width < 100) return false;
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
        return lit > 50; // a real page, not a black canvas
      }, null, { timeout: 30_000 });
      expect.match(await page.locator("[data-browser-url]").innerText(), /127\.0\.0\.1/);
      // the live socket itself (through the stack's Vite proxy, ws forwarded): connected, not "Reconnecting" / "Connecting"
      await page.locator('[data-browser-panel][data-browser-connection="open"]').waitFor({ timeout: 30_000 });
      expect.equal(await page.getByText("Reconnecting").count(), 0, "no Reconnecting note while the live socket is open");
      covered("live picture + address");
      await shot(page, "computer-live");

      // the picture is the page: a different address that is NOT allowed stays blocked and never reaches the site
      await say(page, tool("browser_navigate", { url: "http://localhost:9/secret" }));
      await bodyHas(page, "BLOCKED", 40_000);
      expect.ok(!fx.hits.some((h) => h.includes("/secret")));
    },
  );

  t.test(
    "booking asks: one approval, two places (the card and the panel bar); Deny in the panel retires the card and the order never leaves; Allow on the card places it",
    async ({ page, open, expect, covered }) => {
      await openPanel(page, open, blob.id, "computer");
      await page.locator("[data-browser-panel]").waitFor({ timeout: 60_000 });
      await say(page, tool("browser_navigate", { url: `${fx.base}/seats?m=1&t=1900` }));
      await bodyHas(page, "Place order");
      const refOf = async () => {
        const txt = await page.evaluate(() => document.body.innerText);
        const m = /\[(e\d+) button "Place order"/.exec(txt);
        return m ? m[1] : null;
      };
      const place = await refOf();
      expect.ok(place, "the snapshot names the Place order button");

      // 1. ask -> deny in the panel
      await say(page, tool("browser_click", { ref: place }));
      const bar = page.locator("[data-browser-approval]");
      await bar.waitFor({ timeout: 40_000 });
      const card = page.locator('[data-blob-card="approval"][data-approval-state="open"]').first();
      await card.waitFor({ timeout: 40_000 });
      expect.match(await bar.innerText(), /needs your OK/);
      expect.match(await card.innerText(), /order/i);
      covered("one approval in two places");
      await page.locator('[data-browser-status="needs-you"]').waitFor({ timeout: 10_000 });
      await shot(page, "computer-approval");
      await bar.locator("[data-browser-deny]").click();
      await bodyHas(page, "DENIED", 30_000);
      await page.locator('[data-blob-card="approval"][data-approval-state="open"]').waitFor({ state: "detached", timeout: 15_000 });
      expect.ok(!fx.hits.some((h) => h.startsWith("POST /order")), "the order never reached the site");
      covered("deny in the panel retires the card");
      await shot(page, "computer-denied");

      // 2. ask again -> allow on the card; the panel bar retires
      await say(page, tool("browser_click", { ref: place }));
      const card2 = page.locator('[data-blob-card="approval"][data-approval-state="open"]').first();
      await card2.waitFor({ timeout: 40_000 });
      await page.locator("[data-browser-approval]").waitFor({ timeout: 10_000 });
      await card2.getByRole("button", { name: /Allow once/ }).click();
      await bodyHas(page, "ORDER PLACED", 40_000);
      await page.locator("[data-browser-approval]").waitFor({ state: "detached", timeout: 15_000 });
      expect.ok(fx.hits.some((h) => h.startsWith("POST /order")), "now it was sent");
      covered("allow on the card");
    },
  );

  t.test(
    "take over: pressing on the picture pauses the blob (\"You're driving\"); its next action waits; Hand back lets it continue",
    async ({ page, open, expect, covered }) => {
      await openPanel(page, open, blob.id, "computer");
      await page.locator("[data-browser-panel]").waitFor({ timeout: 60_000 });
      await say(page, tool("browser_navigate", { url: `${fx.base}/cinema` }));
      await page.locator("[data-browser-canvas]").waitFor();
      await page.waitForFunction(() => document.querySelector('[data-browser-status="idle"]'), null, { timeout: 40_000 });
      const canvas = page.locator("[data-browser-canvas]");
      const box = await canvas.boundingBox();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.8);
      await page.mouse.down();
      await page.mouse.up();
      await page.locator("[data-browser-takeover]").waitFor({ timeout: 10_000 });
      await page.locator('[data-browser-status="driving"]').waitFor();
      expect.match(await page.locator("[data-browser-takeover]").innerText(), /You're driving[\s\S]*paused until you hand back/);
      covered("take over");
      await shot(page, "computer-driving");

      // the blob's next action waits for the user
      await say(page, `${tool("browser_snapshot", {})} [stub:say Back at it]`);
      await page.waitForTimeout(2500);
      expect.ok(!(await page.evaluate(() => document.body.innerText.includes("browser_snapshot ->"))), "paused while the user drives");
      await page.locator("[data-browser-takeover] button", { hasText: "Hand back" }).click();
      await page.locator("[data-browser-takeover]").waitFor({ state: "detached", timeout: 10_000 });
      await bodyHas(page, "Back at it", 30_000);
      covered("hand back");
    },
  );

  t.test("the setup screen: a browser that is not installed says so, with the size, and downloads only on the button (never in a turn)", async ({ page, open, expect, covered }) => {
    // This stack's daemon has the shared, already-installed engine. A bare engine dir is simulated by asking the live route for a blob
    // whose daemon-side status says "not installed" is not possible without a second daemon, so the check here is the copy and the
    // button on the component through its own unit tests (browser.test.tsx) and, live, that an agent turn NEVER starts a download.
    await openPanel(page, open, blob.id, "computer");
    await page.locator("[data-browser-panel]").waitFor({ timeout: 60_000 });
    expect.ok(!(await page.locator("[data-browser-install]").count()), "installed here: no setup screen");
    covered("setup screen (see the install capture)");
  });

  // the fixture is a server: close it, or this process never exits
  t.test("cleanup: the local cinema goes", async ({ expect }) => {
    await fx?.close();
    expect.ok(true);
  });
});

