// 20-blobs: routines and webhooks in the REAL app (daemon + ui-server + UI), with the QA stub engine standing in for the model
// (qa/stacks/env.cjs: KORA_QA_STUB_ENGINE=1). Create a weekday routine and read its preview, run it now and follow the report to
// the hidden run and back, pause and resume, and the webhook: secret once, then a real HTTP POST at the receiver starts a run.
import fs from "node:fs";

import { spec } from "../lib/harness.mjs";
import { STACK, blobHomeFile, createBlob, hireStarterOnDisk, openPanel, readJson, webhookBase } from "./blobUi.mjs";

const rand = () => Date.now().toString(36).slice(-4);
let B = null; // the blob under test
let routineId = null;
const routinesOnDisk = () => readJson("blobs", B.id, "routines.json").routines;
const runsOnDisk = () => {
  try {
    const rows = fs.readFileSync(blobHomeFile(B.id, "routine-runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const by = new Map();
    for (const r of rows) by.set(r.id, r);
    return [...by.values()];
  } catch {
    return [];
  }
};

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "a weekday routine: the picker says Weekdays, the next times are 8:00 AM in the routine's own zone, Monday is not skipped",
    async ({ page, open, sleep, expect, covered }) => {
      B = await createBlob(page, open, `Rout${rand()}`);
      await openPanel(page, open, B.id, "runs");
      await page.locator("[data-new-routine]").first().click();
      await page.getByLabel("Name", { exact: true }).fill("Morning brief");
      await page.getByLabel("What should it do?").fill("Write my morning brief: calendar first, then the news. Keep it short.");
      // Days & time is the default shape: Mon-Fri 08:00
      const presets = page.locator("[data-day-presets]");
      await presets.waitFor();
      const lit = await presets.locator('[aria-checked="true"]').allInnerTexts();
      expect.deepEqual(lit, ["Weekdays"], "the lit preset says what the days are");
      expect.ok(!(await presets.innerText()).includes("Every day Every day"));
      await page.locator("#rt-tz").fill("Asia/Calcutta");
      await page.locator("#rt-time").fill("08:00");
      const preview = page.locator("[data-cadence-preview]");
      await page.waitForFunction(() => /Next:/.test(document.querySelector("[data-cadence-preview]")?.textContent ?? ""), null, { timeout: 15_000 });
      const sentence = await preview.innerText();
      expect.ok(/Weekdays at 8:00 AM \(Asia\/Calcutta\)/.test(sentence), sentence);
      const next = await page.locator("[data-next-times]").innerText();
      // the browser's own locale decides the date's wording ("Mon, Oct 12" / "Mon 12 Oct"); the hour reads 12-hour like the sentence
      const times = [...next.matchAll(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b[^·]*?(\d{1,2}:\d{2}\s?[AaPp][Mm])/g)];
      expect.ok(times.length >= 3, `three next times, got: ${next}`);
      for (const m of times) {
        expect.equal(m[2].replace(/\s/g, "").toUpperCase(), "8:00AM", `every next time reads 8:00 AM in Calcutta (${m[0]})`);
        expect.ok(!["Sat", "Sun"].includes(m[1]), `no weekend run (${m[0]})`);
      }
      covered("Routines › weekday label, next times in the routine's zone");
      await page.locator("[data-save-routine]").click();
      await page.locator("[data-routine]").first().waitFor({ timeout: 15_000 });
      await sleep(400);
      const saved = routinesOnDisk().find((r) => r.title === "Morning brief");
      expect.ok(saved, "the routine is on disk");
      routineId = saved.id;
      expect.equal(saved.cadence.kind, "weekly");
      expect.deepEqual(saved.cadence.days, [1, 2, 3, 4, 5]);
      expect.equal(saved.cadence.tz, "Asia/Calcutta");
      expect.equal(saved.cadence.time, "08:00");
      expect.equal(saved.paused, false);
      const row = page.locator(`[data-routine="${routineId}"]`);
      expect.ok(/Weekdays at 8:00 AM/.test(await row.innerText()), "the row says Weekdays");
      expect.ok(/Next /.test(await row.locator("[data-routine-state]").innerText()), "and when it runs next");
      covered("Routines › create → row + file");
    },
    { control: "Routines › create weekday routine", severity: "broken" },
  );

  t.test(
    "run now with the stub engine: a Done receipt, a dated report row in the results thread, Open run and Back to results; the run is hidden everywhere else",
    async ({ page, open, sleep, expect, covered }) => {
      await openPanel(page, open, B.id, "runs");
      await page.getByRole("button", { name: "Run Morning brief now" }).click();
      const done = page.locator('[data-run] [data-run-status="completed"]');
      await done.first().waitFor({ timeout: 60_000 });
      covered("Routines › run now → Done receipt");
      const run = runsOnDisk().find((r) => r.status === "completed" && r.source === "manual");
      expect.ok(run, "completed manual run on disk");
      expect.ok(run.threadId && run.resultsThreadId, "it has a hidden thread and a results thread");
      expect.ok(/Routine brief \(stub engine\)/.test(run.report), `the report is the stub's: ${run.report}`);

      // the hidden execution thread is in no list: not the roster, not the sidebar
      await sleep(500);
      const sidebar = await page.locator("[data-slot='sidebar']").innerText();
      expect.ok(!/Morning brief ·/.test(sidebar.replace(/Morning brief · results/g, "")), `the run thread must not be listed: ${sidebar.slice(0, 400)}`);
      covered("Routines › execution thread hidden from the sidebar");

      // the results thread holds the report; "See report" goes there
      await page.getByRole("button", { name: /See report/ }).first().click();
      const card = page.locator(`[data-routine-report="${run.id}"]`);
      await card.waitFor({ timeout: 30_000 });
      expect.ok(/Routine brief \(stub engine\)/.test(await card.innerText()));
      expect.ok(/Morning brief/.test(await card.innerText()));
      covered("Routines › report row in the results thread");

      // Open run: the hidden thread, with its banner and the way back
      await card.locator("[data-open-run]").click();
      await page.locator("[data-routine-run-banner]").waitFor({ timeout: 30_000 });
      expect.ok(page.url().includes(run.threadId), "the URL is the hidden run thread");
      const banner = await page.locator("[data-routine-run-banner]").innerText();
      expect.ok(/Routine run/.test(banner) && /Morning brief/.test(banner), banner);
      await page.locator("[data-back-to-results]").click();
      await page.locator(`[data-routine-report="${run.id}"]`).waitFor({ timeout: 30_000 });
      expect.ok(page.url().includes(run.resultsThreadId), "Back to results returns to the results thread");
      covered("Routines › Open run / Back to results");

      // the hidden run is reachable by id after a reload too (it is not deleted, only unlisted)
      await open(`/${run.threadId.length ? "kora-local" : ""}/${run.threadId}`, { wait: false });
      await page.locator("[data-routine-run-banner]").waitFor({ timeout: 40_000 });
    },
    { control: "Routines › run now, report, Open run / Back", severity: "broken" },
  );

  t.test(
    "pause and resume: the switch writes the file, a paused routine says Paused and has no next run, resume schedules it again",
    async ({ page, open, sleep, expect, covered }) => {
      await openPanel(page, open, B.id, "runs");
      const row = page.locator(`[data-routine="${routineId}"]`);
      await row.waitFor({ timeout: 20_000 });
      await row.getByRole("switch").click();
      await sleep(900);
      expect.equal(routinesOnDisk().find((r) => r.id === routineId).paused, true);
      expect.ok(/Paused/.test(await row.locator("[data-routine-state]").innerText()));
      expect.ok(await row.getByRole("button", { name: /Run Morning brief now/ }).isEnabled(), "a paused routine can still be run by hand");
      await row.getByRole("switch").click();
      await sleep(900);
      expect.equal(routinesOnDisk().find((r) => r.id === routineId).paused, false);
      expect.ok(/Next /.test(await row.locator("[data-routine-state]").innerText()));
      covered("Routines › pause / resume");
    },
    { control: "Routines › pause and resume", severity: "broken" },
  );

  t.test(
    "a webhook: the secret is shown once, a real POST at the receiver starts a run, a wrong secret and a stranger are refused",
    async ({ page, open, sleep, expect, covered }) => {
      await openPanel(page, open, B.id, "runs");
      await page.getByRole("button", { name: "Edit Morning brief" }).click();
      await page.locator("[data-add-webhook]").click();
      await page.getByLabel("Webhook name").fill("Deploys");
      await page.locator("[data-webhook-create]").click();
      const reveal = page.locator("[data-secret-reveal]");
      await reveal.waitFor({ timeout: 15_000 });
      const secret = (await reveal.locator("[data-secret-value]").innerText()).trim();
      expect.ok(/^whsec_/.test(secret), "a secret that looks like one");
      const curl = await reveal.locator("[data-curl]").innerText();
      expect.ok(curl.includes(secret) && curl.includes("Authorization: Bearer"), "the ready-made curl line carries it");
      const trig = routinesOnDisk().find((r) => r.id === routineId).triggers[0];
      expect.ok(trig && trig.secretHash && !JSON.stringify(trig).includes(secret), "only a hash is stored, never the secret");
      covered("Webhooks › create → secret once");

      // I saved it: the secret leaves the page and is not recoverable
      await page.locator("[data-secret-done]").click();
      expect.equal(await page.locator("[data-secret-value]").count(), 0, "the secret is gone from the DOM");
      expect.ok(!(await page.content()).includes(secret), "and from the page");

      // the receiver, from outside the app (loopback only)
      const base = webhookBase();
      const health = await fetch(`${base}/health`).then((r) => r.status);
      expect.equal(health, 200);
      const url = `${base}/hooks/${trig.id}`;
      const body = JSON.stringify({ event: "deploy.finished", status: "ok" });
      const wrong = await fetch(url, { method: "POST", headers: { authorization: "Bearer whsec_nope", "content-type": "application/json" }, body });
      expect.equal(wrong.status, 401, "a wrong secret is refused");
      const unknown = await fetch(`${base}/hooks/wh_0000000000000000`, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body });
      expect.equal(unknown.status, 401, "an unknown id answers exactly like a wrong secret");
      expect.equal((await fetch(`${base}/nope`)).status, 404);
      const before = runsOnDisk().filter((r) => r.source === "webhook").length;
      const ok = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body });
      expect.ok(ok.status === 200 || ok.status === 202, `accepted, got ${ok.status}`);
      covered("Webhooks › POST starts a run; wrong secret refused");

      // the run is queued then runs: the log shows it as a Webhook run and the stub saw the fenced body
      await page.getByRole("button", { name: "Cancel" }).first().click().catch(() => {});
      await page.keyboard.press("Escape");
      await page.locator("[data-run] [data-run-status]").first().waitFor({ timeout: 30_000 });
      await page.waitForFunction(() => /Webhook/.test(document.querySelector("[data-run-log]")?.textContent ?? ""), null, { timeout: 60_000 });
      await sleep(1500);
      const hooked = runsOnDisk().filter((r) => r.source === "webhook");
      expect.equal(hooked.length, before + 1, "one webhook run");
      const final = hooked.at(-1);
      expect.ok(["queued", "active", "completed"].includes(final.status), final.status);
      if (final.status === "completed") expect.ok(/event, status/.test(final.report ?? ""), `the stub echoes the event's keys: ${final.report}`);
      expect.equal(final.eventPayload ?? null, null, "the untrusted body is not kept once the run ends");
      covered("Webhooks › run shows in the log as Webhook");
    },
    { control: "Webhooks › secret once, POST → run", severity: "broken" },
  );

  t.test(
    "a hired starter's routine arrives paused as a suggestion with its own words; Turn on makes it real",
    async ({ page, open, sleep, expect, covered }) => {
      const tibbo = hireStarterOnDisk("tibbo", "Tibbo");
      await sleep(500);
      const onDisk = readJson("blobs", tibbo.id, "routines.json").routines;
      expect.equal(onDisk.length, 1);
      expect.equal(onDisk[0].paused, true, "a starter's routine is never running until you turn it on");
      expect.ok(/morning brief/i.test(onDisk[0].prompt) && onDisk[0].prompt.length > 80, "a real prompt, not a placeholder line");
      await openPanel(page, open, tibbo.id, "runs");
      const row = page.locator("[data-routine]").first();
      await row.waitFor({ timeout: 20_000 });
      const label = await row.innerText();
      expect.ok(/Suggested/.test(label), label);
      expect.ok(/Weekdays at 8:00 AM/.test(label), label);
      await sleep(400);
      const upgraded = readJson("blobs", tibbo.id, "routines.json").routines[0];
      expect.equal(upgraded.createdBy, "template", "the daemon turned the starter's note into a real (paused) routine");
      expect.ok(upgraded.id && upgraded.cadence?.kind === "weekly", "with a real schedule");
      covered("Routines › starter routine arrives paused (Suggested)");
      await row.getByRole("button", { name: "Turn on" }).click();
      await sleep(900);
      expect.equal(readJson("blobs", tibbo.id, "routines.json").routines[0].paused, false);
      expect.ok(/Next /.test(await row.locator("[data-routine-state]").innerText()));
      covered("Routines › Turn on resumes it");
    },
    { control: "Routines › starter routine paused → Turn on", severity: "broken" },
  );
});
