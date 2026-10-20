// 20-blobs: the blob browser's one-time setup, driven from the UI with NO engine installed (live QA #4: the Computer tab said
// "Connecting / Reconnecting" forever and nothing offered the download). The stack's daemon is restarted with an EMPTY engine
// dir and a tiny engine served from this machine (`KORA_BROWSER_TEST_SOURCE`, loopback only); the real install code runs
// against it: download, SHA-256 check, extract, warm, ready.json.
//   - the Computer tab shows the setup screen (size, Set up) at once, not "Connecting", with the live socket irrelevant
//   - Set up runs the real install and the screen goes away; the engine's ready.json is on disk
//   - Settings > Blobs and the blob's Browser settings show the same status
//   - the daemon is put back on its normal engine at the end
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spec } from "../lib/harness.mjs";
import { STACK, createBlob, openPanel } from "./blobUi.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const ASSETS = path.join(ROOT, "docs/bots/assets");
const stamp = Date.now().toString(36).slice(-4);
const NAME = `Setty${stamp}`;

const shot = async (page, name) => {
  fs.mkdirSync(ASSETS, { recursive: true });
  await page.screenshot({ path: path.join(ASSETS, `f3-${name}.png`) });
};

let tmp = null;
let server = null;
let engineDir = null;
let blob = null;

/** A zip with a fake `chrome-headless-shell` (a script that answers --version), its hash and size. */
function makeFakeEngineZip(dir) {
  const stage = path.join(dir, "stage", "chrome-headless-shell-fake");
  fs.mkdirSync(stage, { recursive: true });
  const bin = path.join(stage, "chrome-headless-shell");
  fs.writeFileSync(bin, "#!/bin/sh\necho 'Fake Headless Shell 1.0.0.1'\n", { mode: 0o755 });
  const zip = path.join(dir, "engine.zip");
  execFileSync("/usr/bin/zip", ["-qry", zip, "chrome-headless-shell-fake"], {
    cwd: path.join(dir, "stage"),
  });
  const bytes = fs.readFileSync(zip);
  return {
    bytes,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

function restartDaemon(env) {
  const full = { ...process.env, ...env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete full[k];
  const ctl = (cmd) =>
    execFileSync(process.execPath, [path.join(ROOT, "qa/stacks/stack.cjs"), cmd, String(STACK)], {
      env: full,
      stdio: "ignore",
      timeout: 90_000,
    });
  ctl("stop");
  ctl("start");
}

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "no engine installed: the Computer tab offers Set up (not 'Connecting'), the real install runs from the button, and it is Ready after",
    async ({ page, open, expect, covered }) => {
      tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qa-engine-"));
      engineDir = path.join(tmp, "browser");
      fs.mkdirSync(engineDir, { recursive: true });
      const fake = makeFakeEngineZip(tmp);
      let downloads = 0;
      server = http.createServer((req, res) => {
        downloads++;
        res.writeHead(200, { "content-type": "application/zip", "content-length": fake.size });
        // two pieces, a beat apart, so the progress bar has something to show
        res.write(fake.bytes.subarray(0, Math.floor(fake.size / 2)));
        setTimeout(() => res.end(fake.bytes.subarray(Math.floor(fake.size / 2))), 700);
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${server.address().port}/engine.zip`;
      restartDaemon({
        KORA_QA_BROWSER_DIR: engineDir,
        KORA_QA_BROWSER_TEST_SOURCE: JSON.stringify({
          version: "1.0.0.1",
          url,
          sha256: fake.sha256,
          size: fake.size,
          dirName: "chrome-headless-shell-fake",
          binRel: "chrome-headless-shell",
        }),
      });

      blob = await createBlob(page, open, NAME);
      await openPanel(page, open, blob.id, "computer");
      const setup = page.locator("[data-browser-install]");
      await setup.waitFor({ timeout: 60_000 });
      expect.match(await setup.innerText(), /Give blobs a browser/);
      expect.match(await setup.innerText(), /one-time download/);
      expect.ok(
        !/Connecting|Reconnecting/.test(await page.locator("[data-computer-tab]").innerText()),
        "no endless Connecting",
      );
      expect.equal(downloads, 0, "nothing downloads until the button");
      covered("setup screen with no engine, without the socket");
      await shot(page, "browser-setup");

      const seen = [];
      page.on("response", (r) => {
        if (/blob-browser\/engine/.test(r.url()))
          seen.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`);
      });
      await page.locator("[data-browser-install-button]").click();
      await page
        .waitForFunction(() => !document.querySelector("[data-browser-install]"), null, {
          timeout: 60_000,
        })
        .catch(async (e) => {
          const screen = await page
            .locator("[data-computer-tab]")
            .innerText()
            .catch(() => "?");
          throw new Error(
            `${e.message} (engine requests: ${seen.join(" | ") || "none"}; screen: ${screen.replace(/\s+/g, " ").slice(0, 300)})`,
          );
        });
      expect.equal(downloads, 1, "one download");
      const dirs = fs.readdirSync(engineDir).filter((d) => /^1\.0\.0\.1-/.test(d));
      expect.equal(dirs.length, 1, `an installed engine under ${engineDir}`);
      expect.ok(
        fs.existsSync(path.join(engineDir, dirs[0], "ready.json")),
        "ready.json written after the hash check",
      );
      await page.locator("[data-browser-panel]").waitFor({ timeout: 30_000 });
      covered("install from the UI, then the panel");
      await shot(page, "browser-ready");
    },
  );

  t.test(
    "Settings > Blobs and the blob's Browser settings show the same state",
    async ({ page, open, expect, covered }) => {
      await open("/settings/blobs");
      const row = page.locator("[data-browser-engine-row]").first();
      await row.waitFor({ timeout: 30_000 });
      expect.equal(await row.getAttribute("data-browser-engine-row"), "ready");
      expect.match(await row.innerText(), /Browser ready/);
      await openPanel(page, open, blob.id, "computer");
      await page.locator("[data-browser-settings-toggle]").click();
      const inSettings = page.locator("[data-browser-settings] [data-browser-engine-row]");
      await inSettings.waitFor({ timeout: 15_000 });
      expect.equal(await inSettings.getAttribute("data-browser-engine-row"), "ready");
      covered("engine row in Settings and in Browser settings");
      await shot(page, "browser-engine-row");
    },
  );

  t.test(
    "cleanup: the daemon goes back to its normal engine dir; the fake engine and its server go",
    async ({ expect }) => {
      restartDaemon({
        KORA_QA_BROWSER_DIR: process.env.KORA_QA_BROWSER_DIR,
        KORA_QA_BROWSER_TEST_SOURCE: undefined,
      });
      await new Promise((r) => (server ? server.close(() => r()) : r()));
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      expect.ok(true);
    },
  );
});
