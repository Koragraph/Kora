// 20-blobs: Kora's team cards in the REAL app: the job card, proposal cards (Hire / Tweak / Not this) and confirm cards
// (edit / retire), with the daemon behind them. `qa/scripts/blobs-seed-team.cjs` writes the scenario with the runtime's own
// stores (no model), so every click runs the real hire / dismiss / confirm / cancel / undo code and the files on disk
// are checked afterwards. The "from Kora" thread label is checked on the delegated thread and in the roster.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spec } from "../lib/harness.mjs";
import { loadBlob } from "./blobSeed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, "../../../docs/bots/assets");
const ROOT = path.resolve(HERE, "../../..");
const { stack: stackEnv } = createRequire(import.meta.url)("../../stacks/env.cjs");
const STACK = Number(process.env.KORA_QA_BLOBS_STACK ?? 2);
const home = () => stackEnv(STACK).home;
let T = null;

const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(home(), ...p), "utf8"));
const proposalRow = (id) => readJson("blobs", "proposals.json").rows.find((r) => r.id === id);
const confirmRow = (id) => readJson("blobs", "confirms.json").rows.find((r) => r.id === id);
const profileOnDisk = (id) => readJson("blobs", id, "profile.json");

// The transcript is virtualized: a row far from the viewport is not in the DOM. Scroll toward `locator` until it is.
async function reveal(page, locator) {
  await page.mouse.move(900, 500);
  for (const direction of [-1, 1]) {
    for (let i = 0; i < 14; i += 1) {
      if ((await locator.count()) > 0) {
        await locator.first().scrollIntoViewIfNeeded();
        return locator.first();
      }
      await page.mouse.wheel(0, direction * 500);
      await page.waitForTimeout(220);
    }
  }
  throw new Error(`could not scroll to ${locator}`);
}
/** A flight lasts under a second: record that one ever existed instead of polling for it. */
const watchFlights = (page) =>
  page.evaluate(() => {
    window.__blobFlew = false;
    new MutationObserver(() => {
      if (document.querySelector("[data-hire-fly]")) window.__blobFlew = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
const proposalCard = (page, name) =>
  page.locator("[data-blob-card='proposal']").filter({ hasText: name });
const confirmCard = (page, text) =>
  page.locator("[data-blob-card='confirm']").filter({ hasText: text });

async function openKora(page, open) {
  await open(`/kora-local/${T.koraThreadId}`, { wait: false });
  await page
    .locator("[data-blob-card='job']")
    .first()
    .waitFor({ timeout: 60_000 })
    .catch(() => {});
  await page.waitForTimeout(800);
}

spec("20-blobs-team", { stack: STACK }, async (t) => {
  t.test(
    "set up: the team, its cards and a delegated thread, written with the runtime's own stores",
    async () => {
      const out = execFileSync(
        process.execPath,
        [path.join(ROOT, "qa/scripts/blobs-seed-team.cjs"), String(STACK), "--force"],
        {
          encoding: "utf8",
          env: process.env,
          timeout: 240_000,
        },
      );
      T = JSON.parse(out.trim().split("\n").pop());
    },
    { control: "Blobs › team seed", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "job card in Kora's thread: title, one status word, steps with their blob, what waits on what, a From Kora link",
    async ({ page, open, expect, inkCheck }) => {
      await openKora(page, open);
      const job = page.locator("[data-blob-card='job']").first();
      await reveal(page, page.locator("[data-blob-card='job']"));
      expect.equal(await job.getAttribute("data-job-status"), "running");
      expect.equal((await page.locator("[data-job-word]").first().innerText()).trim(), "Running");
      expect.ok((await job.innerText()).includes("Lisbon trip"));
      expect.ok((await page.locator("[data-job-step='s1']").innerText()).includes("Popo · done"));
      expect.ok((await page.locator("[data-job-step='s2']").innerText()).includes("Junip"));
      expect.ok(
        (await page.locator("[data-job-step='s3']").innerText()).includes("after"),
        "s3 waits on s2",
      );
      expect.equal(
        await page.locator("[data-job-step='s1'] [data-step-open]").count(),
        1,
        "the finished step links to its thread",
      );
      // not started yet: it can be changed (Edit prefills Kora's composer) or cancelled; a finished one cannot
      expect.equal(await page.locator("[data-job-step='s2'] [data-step-cancel]").count(), 1);
      expect.equal(await page.locator("[data-job-step='s1'] [data-step-cancel]").count(), 0);
      expect.equal(
        await page.locator("[data-job-step='s2'] [data-step-edit]").count(),
        1,
        "Edit is wired to the composer",
      );
      const cold = (await inkCheck({ root: "[data-blob-card='job']" })).filter(
        (h) => h.kind === "cold",
      );
      expect.equal(cold.length, 0);
    },
    { control: "Blobs › job card (wired)", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "Edit on a step puts 'Change step …' in Kora's composer",
    async ({ page, open, expect }) => {
      await openKora(page, open);
      await reveal(page, page.locator("[data-job-step='s2'] [data-step-edit]"));
      await page.locator("[data-job-step='s2'] [data-step-edit]").first().click();
      await page.waitForTimeout(400);
      const text = await page.locator('[contenteditable="true"]').first().innerText();
      expect.ok(/Change step "Draft the out-of-office email"/.test(text), text);
    },
    { control: "Blobs › job step edit (wired)", severity: "wrong", ignoreErrors: true },
  );

  t.test(
    "the finished step opens its 'from Kora' thread: header label, and the roster marks the thread",
    async ({ page, open, sleep, expect }) => {
      await openKora(page, open);
      await reveal(page, page.locator("[data-job-step='s1'] [data-step-open]"));
      await page.locator("[data-job-step='s1'] [data-step-open]").first().click();
      await page.locator("[data-from-kora-label]").first().waitFor({ timeout: 30_000 });
      expect.ok(
        (await page.locator("[data-from-kora-label]").first().innerText()).includes("from Kora"),
      );
      expect.ok(/Alfama and Graça/.test(await page.locator("main").innerText()));
      await sleep(500);
      // Popo's thread list in the sidebar carries the mark
      await page
        .locator("[data-blobs-roster] [data-from-kora-mark]")
        .first()
        .waitFor({ timeout: 15_000 });
      expect.equal(page.url().includes(T.popoThreadId), true);
    },
    { control: "Blobs › from Kora label (wired)", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "Tweak opens the full editor pre-filled; Create hires through the proposal and the card flips to hired",
    async ({ page, open, expect }) => {
      await openKora(page, open);
      const card = await reveal(page, proposalCard(page, "Zibbo"));
      expect.ok((await card.innerText()).includes("Receipts Clerk"));
      await card.locator("[data-proposal-tweak]").click();
      await page.locator("[data-blob-editor]").waitFor({ timeout: 15_000 });
      const name = page.getByLabel("Name", { exact: true });
      expect.equal(await name.inputValue(), "Zibbo", "the editor starts from the proposal");
      await page.locator('[data-editor-section="soul"]').click();
      expect.ok(
        (await page.locator("[data-blob-editor] textarea").first().inputValue()).includes(
          "receipts clerk",
        ),
        "its soul is the proposal's",
      );
      await page.locator('[data-editor-section="identity"]').click();
      await name.fill("Zibbo Two");
      await page.locator("[data-editor-save]").click();
      await page.locator("[data-blob-editor]").waitFor({ state: "detached", timeout: 20_000 });
      await page
        .locator("[data-proposal-state='hired']")
        .filter({ hasText: "Zibbo Two" })
        .first()
        .waitFor({ timeout: 20_000 });
      // the daemon: blob created from the edited draft, proposal marked hired, routines stored paused
      const blob = loadBlob(STACK, "Zibbo Two");
      expect.equal(proposalRow(T.proposals.tweak).state, "hired");
      expect.equal(proposalRow(T.proposals.tweak).hiredBlobId, blob.id);
      const routines = readJson("blobs", blob.id, "routines.json").routines;
      expect.ok(
        routines.length === 1 && routines[0].paused === true,
        "suggested routines arrive paused",
      );
      await page
        .locator(`[data-blobs-roster] [data-blob-id='${blob.id}']`)
        .first()
        .waitFor({ timeout: 15_000 });
    },
    { control: "Blobs › proposal Tweak (wired)", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "Hire on a proposal card: the blob flies to the roster and the card becomes 'joined the team'; it survives a reload",
    async ({ page, open, sleep, expect }) => {
      await openKora(page, open);
      const card = await reveal(page, proposalCard(page, "Tiki"));
      await watchFlights(page);
      await card.locator("[data-proposal-hire]").click();
      await page
        .locator("[data-proposal-state='hired']")
        .filter({ hasText: "Tiki" })
        .first()
        .waitFor({ timeout: 20_000 });
      await sleep(1500);
      expect.ok(await page.evaluate(() => window.__blobFlew === true), "the hire flight ran");
      await page
        .locator("[data-proposal-state='hired']")
        .filter({ hasText: "Tiki" })
        .first()
        .waitFor({ timeout: 20_000 });
      const blob = loadBlob(STACK, "Tiki");
      expect.equal(proposalRow(T.proposals.hire).hiredBlobId, blob.id);
      await page
        .locator(`[data-blobs-roster] [data-blob-id='${blob.id}']`)
        .first()
        .waitFor({ timeout: 15_000 });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 60_000 });
      const again = await reveal(
        page,
        page.locator("[data-proposal-state='hired']").filter({ hasText: "Tiki" }),
      );
      expect.ok(again);
      expect.equal(
        await proposalCard(page, "Tiki").locator("[data-proposal-hire]").count(),
        0,
        "still hired after a reload (v2 won)",
      );
    },
    { control: "Blobs › proposal Hire (wired)", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "Not this dismisses a proposal; the dismissal is remembered",
    async ({ page, open, expect }) => {
      await openKora(page, open);
      const card = await reveal(page, proposalCard(page, "Wumpy"));
      await card.locator("[data-proposal-dismiss]").click();
      await page
        .locator("[data-proposal-state='dismissed']")
        .filter({ hasText: "Wumpy" })
        .first()
        .waitFor({ timeout: 15_000 });
      expect.equal(proposalRow(T.proposals.dismiss).state, "dismissed");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 60_000 });
      await reveal(
        page,
        page.locator("[data-proposal-state='dismissed']").filter({ hasText: "Wumpy" }),
      );
    },
    { control: "Blobs › proposal dismiss (wired)", severity: "wrong", ignoreErrors: true },
  );

  t.test(
    "confirm card (edit): details shown, Confirm applies it, a receipt with Undo appears, Undo restores everything",
    async ({ page, open, expect }) => {
      await openKora(page, open);
      const card = await reveal(page, confirmCard(page, "Update Popo"));
      expect.equal(await card.getAttribute("data-confirm-state"), "open");
      expect.ok((await card.innerText()).includes("Title: Researcher -> Lead Researcher"));
      await card.locator("[data-confirm-yes]").click();
      await page.locator("[data-confirm-state='confirmed']").first().waitFor({ timeout: 15_000 });
      expect.equal(profileOnDisk(T.popo.id).title, "Lead Researcher");
      expect.equal(confirmRow(T.confirms.edit).state, "confirmed");
      const receipt = await reveal(
        page,
        page.locator("[data-blob-card='self-change']").filter({ hasText: "Kora changed Popo" }),
      );
      await receipt.getByRole("button", { name: "Undo" }).click();
      await page
        .locator("[data-blob-card='self-change-undone']")
        .filter({ hasText: "Kora changed Popo" })
        .first()
        .waitFor({ timeout: 15_000 });
      expect.equal(profileOnDisk(T.popo.id).title, "Researcher", "one Undo put the title back");
    },
    { control: "Blobs › confirm edit + undo (wired)", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "confirm card (retire): Not now leaves the blob on the team",
    async ({ page, open, expect }) => {
      await openKora(page, open);
      const card = await reveal(page, confirmCard(page, "Retire Junip"));
      expect.equal((await card.locator("[data-confirm-yes]").innerText()).trim(), "Retire");
      await card.locator("[data-confirm-no]").click();
      await page.locator("[data-confirm-state='dismissed']").first().waitFor({ timeout: 15_000 });
      expect.equal(profileOnDisk(T.junip.id).archivedAt, null);
      expect.equal(confirmRow(T.confirms.retire).state, "dismissed");
    },
    { control: "Blobs › confirm decline (wired)", severity: "wrong", ignoreErrors: true },
  );

  t.test(
    "Cancel step then Cancel job: the card updates from the daemon's answer and the job stops",
    async ({ page, open, expect }) => {
      await openKora(page, open);
      await reveal(page, page.locator("[data-job-step='s3'] [data-step-cancel]"));
      await page.locator("[data-job-step='s3'] [data-step-cancel]").first().click();
      await page
        .locator("[data-job-step='s3'][data-step-status='cancelled']")
        .waitFor({ timeout: 15_000 });
      expect.equal(
        await page.locator("[data-job-step='s2'][data-step-status='queued']").count(),
        1,
        "only that step",
      );
      await page.locator("[data-job-cancel]").first().click();
      await page
        .locator("[data-blob-card='job'][data-job-status='cancelled']")
        .first()
        .waitFor({ timeout: 15_000 });
      const job = readJson("blobs", "jobs", `${T.jobId}.json`);
      expect.equal(job.cancelled, true);
      expect.deepEqual(
        job.steps.map((s) => s.state),
        ["done", "cancelled", "cancelled"],
      );
    },
    { control: "Blobs › job cancel (wired)", severity: "broken", ignoreErrors: true },
  );
  t.test(
    "a step whose blob ends on a question is parked on the user (it survives a daemon restart): the job card says so, shows the question, and goes back to working once answered",
    async ({ page, open, sleep, expect, covered }) => {
      await open(`/kora-local/${T.needsThreadId}`, { wait: false });
      const card = page.locator("[data-blob-card='job']").first();
      await card.waitFor({ timeout: 60_000 });
      expect.equal(await card.getAttribute("data-job-needs-you"), "true");
      expect.equal(
        (await card.locator("[data-job-word]").innerText()).trim(),
        "Waiting on you",
        "the header says who it waits on, not 'Running'",
      );
      const step = card.locator("[data-job-step='s1']");
      expect.equal(await step.getAttribute("data-step-status"), "needs-you");
      expect.ok(
        (await step.locator("[data-step-question]").innerText()).includes("which dates"),
        "the step shows what was asked",
      );
      fs.mkdirSync(ASSETS, { recursive: true });
      await card.scrollIntoViewIfNeeded();
      await sleep(900);
      await page.screenshot({ path: path.join(ASSETS, "f2-job-needs-you.png") });
      expect.equal(
        readJson("blobs", "jobs", `${T.needsJobId}.json`).steps[0].state,
        "waiting",
        "the restart that ended the seed left the step waiting (not 'checking')",
      );
      covered("Job card › needs-you step, kept across a restart");

      // answering it in the blob's thread (the jump on the card) puts the step back to working, then it finishes
      await step.locator("[data-step-jump]").first().click();
      await page.waitForFunction((id) => location.pathname.includes(id), T.junipThreadId, {
        timeout: 15_000,
      });
      const box = page.locator('[contenteditable="true"]').last();
      await box.waitFor({ timeout: 30_000 });
      await box.click();
      await page.keyboard.type("[stub:say Thanks, I have the dates. Writing the summary now.]");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => (document.body.innerText.match(/Writing the summary now/g) ?? []).length >= 2,
        null,
        { timeout: 45_000 },
      );
      await sleep(1500);
      expect.notEqual(
        readJson("blobs", "jobs", `${T.needsJobId}.json`).steps[0].state,
        "waiting",
        "answered: no longer waiting on the user",
      );
      await open(`/kora-local/${T.needsThreadId}`, { wait: false });
      await page
        .locator("[data-blob-card='job'][data-job-needs-you='false']")
        .first()
        .waitFor({ timeout: 30_000 });
      covered("Job card › answered step leaves needs-you");
    },
    { control: "Blobs › job needs-you (wired)", severity: "broken", ignoreErrors: true },
  );
});
