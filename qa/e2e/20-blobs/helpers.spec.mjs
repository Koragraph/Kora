// 20-blobs: Stop on a blob's chat kills the helpers it started, queued ones included (live QA #2: a cancelled job kept three workers
// running, and a queued fourth started afterwards). The stack's OpenCode is swapped for a FAKE worker (a /bin/sh script that records its
// pid and sleeps), so real panes, worktrees and the real SwarmService run and no model is ever called. At most two helpers run at once
// for one blob chat; the third waits in the queue and must never start once Stop was pressed.
//
// The swap touches only THIS stack's `tools/opencode` link; it is put back when the spec ends.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spec } from "../lib/harness.mjs";
import { STACK, createBlob, home } from "./blobUi.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const ctl = (cmd) =>
  execFileSync(process.execPath, [path.join(ROOT, "qa/stacks/stack.cjs"), cmd, String(STACK)], {
    stdio: "ignore",
    timeout: 90_000,
  });
const NAME = `Help${Date.now().toString(36).slice(-4)}`;
const link = () => path.join(home(), "tools", "opencode");
const pidFile = () => path.join(home(), "fake-workers.pids");
let saved = null;

function installFakeWorker() {
  const l = link();
  try {
    saved = { target: fs.readlinkSync(l) };
  } catch {
    saved = { target: null };
  }
  fs.rmSync(l, { recursive: true, force: true });
  fs.mkdirSync(path.join(l, "current"), { recursive: true });
  fs.rmSync(pidFile(), { force: true });
  const script = `#!/bin/sh
case "$1" in --version|-v) echo "1.18.32"; exit 0;; run) echo '{}'; exit 0;; esac
[ -n "$KORA_SWARM_TASK_ID" ] && echo $$ >> "${pidFile()}"
printf 'opencode fake worker\\nAsk anything\\n'
exec sleep 600
`;
  fs.writeFileSync(path.join(l, "current", "opencode"), script, { mode: 0o755 });
}

function restoreRealWorker() {
  if (!saved) return;
  fs.rmSync(link(), { recursive: true, force: true });
  if (saved.target) fs.symlinkSync(saved.target, link());
  saved = null;
}

const pids = () =>
  fs.existsSync(pidFile())
    ? fs
        .readFileSync(pidFile(), "utf8")
        .split("\n")
        .filter(Boolean)
        .map(Number)
    : [];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "Stop on a blob's chat ends its helpers (queued ones too); at most two run at once; the chat never says swarm",
    async ({ page, open, sleep, expect, covered }) => {
      ctl("stop");
      fs.rmSync(path.join(home(), "swarm", "tasks.json"), { force: true }); // tasks of an earlier run would be resumed with the fake worker
      installFakeWorker();
      ctl("start");
      await sleep(10_000); // a daemon that has just started is still warming up: a blob made at once can take a while to open
      try {
        const blob = await createBlob(page, open, NAME);
        await page.locator(`[data-blob-id] [data-blob-row][aria-label^="${NAME}"]`).first().click();
        const box = page.locator('[contenteditable="true"]').last();
        await box.waitFor({ timeout: 40_000 });
        await box.click();
        const spawn = (n) =>
          `[stub:tool kora_spawn ${JSON.stringify({ prompt: `fake task ${n}`, title: `helper ${n}` })}]`;
        await page.keyboard.type(`${spawn(1)} ${spawn(2)} ${spawn(3)} [stub:hold 120000]`);
        await page.keyboard.press("Enter");

        // two helpers start; the third is queued, not running
        const t0 = Date.now();
        while (pids().length < 2 && Date.now() - t0 < 90_000) await sleep(500);
        expect.equal(pids().length, 2, `two helpers started (pids: ${pids()})`);
        await sleep(6000); // a third one must NOT appear while two run
        expect.equal(pids().length, 2, "the cap is two at once for one blob chat");
        expect.ok(pids().every(alive), "both helpers are alive while the chat is working");
        covered("Helpers › two at once, third queued");

        await page.locator('[aria-label="Stop generation"]').first().click();
        const t1 = Date.now();
        while (pids().some(alive) && Date.now() - t1 < 30_000) await sleep(500);
        expect.ok(!pids().some(alive), `Stop ended every helper (still alive: ${pids().filter(alive)})`);
        await sleep(8000); // ... and the queued third never starts afterwards
        expect.equal(pids().length, 2, "the queued helper was dropped, not started after Stop");
        covered("Helpers › Stop kills running and queued helpers");

        const text = await page.evaluate(() => document.body.innerText);
        expect.ok(!/swarm|orchestrator/i.test(text), "a blob chat never shows Swarm wording");
        void blob;
      } finally {
        ctl("stop");
        fs.rmSync(path.join(home(), "swarm", "tasks.json"), { force: true });
        restoreRealWorker();
        ctl("start");
        await sleep(10_000);
        for (const pid of pids()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
        void os;
      }
    },
    { control: "Helpers › Stop kills helpers", severity: "broken", ignoreErrors: true },
  );
});
