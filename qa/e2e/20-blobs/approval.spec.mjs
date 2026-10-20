// 20-blobs: an approval is a card IN the transcript (live QA #2). A blob on Ask asks for every shell command; the card shows the
// whole command and the folder, offers Allow once / Always for this blob / Deny, and never takes the composer away. The QA stub engine
// asks the real permission gate (`[stub:bash <command>]`), so Allow, Always and Deny, the outcome line and the rule on the profile are
// the daemon's own. Nothing is run and no model is called.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spec } from "../lib/harness.mjs";
import { STACK, openPanel, readJson } from "./blobUi.mjs";
import { loadBlob } from "./blobSeed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, "../../../docs/bots/assets");
const stamp = Date.now().toString(36).slice(-4);
const NAME = `Gate${stamp}`;
let B = null;

const OPEN = '[data-blob-card="approval"][data-approval-state="open"]';
const SETTLED = (state) => `[data-blob-card="approval"][data-approval-state="${state}"]`;
const rowOf = (page) => page.locator(`[data-blob-id] [data-blob-row][aria-label^="${NAME}"]`).first();

async function hireAsk(page, open) {
  await open("/blobs", { wait: false });
  await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
  await page.locator("[data-new-blob], [data-blobs-empty] button").first().click();
  await page.locator("[data-blob-editor]").waitFor();
  await page.getByLabel("Name", { exact: true }).fill(NAME);
  await page.locator('[data-editor-section="model"]').click();
  await page.locator('[data-model-mode="pick"]').click();
  await page.locator('[data-editor-section="permissions"]').click();
  await page.locator('[data-permission="ask"]').click();
  await page.locator("[data-editor-save]").click();
  await rowOf(page).waitFor({ timeout: 25_000 });
}

async function say(page, text, open) {
  if (open && B) await open(`/blobs/${B.id}`, { wait: false });
  else await rowOf(page).click();
  const box = page.locator('[contenteditable="true"]').last();
  await box.waitFor({ timeout: 30_000 });
  await box.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

const bodyCount = (page, re) =>
  page.evaluate((src) => (document.body.innerText.match(new RegExp(src, "g")) ?? []).length, re);

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "an Ask blob asks about a shell command in the transcript: the whole command, the folder, three buttons, and the composer stays usable",
    async ({ page, open, sleep, expect, covered }) => {
      await hireAsk(page, open);
      B = loadBlob(STACK, NAME);
      await say(page, "[stub:bash echo hello-f2 one two three four five six seven eight nine ten]");
      const card = page.locator(OPEN).first();
      await card.waitFor({ timeout: 45_000 });
      const text = await card.innerText();
      expect.ok(
        text.includes("echo hello-f2 one two three four five six seven eight nine ten"),
        `the full command is shown: ${text}`,
      );
      expect.ok(
        (await card.locator("[data-approval-cwd]").innerText()).includes(path.basename(B.workspace)),
        "the folder it would run in is shown",
      );
      expect.equal(
        (await card.locator('[data-approval-action="accept"]').innerText()).trim(),
        "Allow once",
      );
      expect.equal(
        (await card.locator('[data-approval-action="acceptAlways"]').innerText()).trim(),
        "Always for this blob",
      );
      expect.equal((await card.locator('[data-approval-action="decline"]').innerText()).trim(), "Deny");
      // the card is a row of the transcript, not a panel over the composer
      const box = page.locator('[contenteditable="true"]').last();
      expect.equal(await box.isVisible(), true, "the composer is still there");
      const cardBox = await card.boundingBox();
      const composerBox = await box.boundingBox();
      expect.ok(cardBox.y + cardBox.height <= composerBox.y, "the card sits above the composer, never over it");
      expect.equal(await page.locator("[data-agent-model-picker]").first().isVisible(), true);
      await box.click();
      await page.keyboard.type("a draft I can still write");
      expect.ok((await box.innerText()).includes("a draft I can still write"), "and it still takes text");
      await page.keyboard.press("Meta+a");
      await page.keyboard.press("Backspace");
      fs.mkdirSync(ASSETS, { recursive: true });
      await page.screenshot({ path: path.join(ASSETS, "f2-approval-card.png") });
      covered("Approval › inline card: command, folder, three buttons, composer intact");

      await card.locator('[data-approval-action="accept"]').click();
      await page.locator(SETTLED("allowed")).first().waitFor({ timeout: 30_000 });
      expect.ok(
        (await page.locator(SETTLED("allowed")).first().innerText()).includes("Allowed once"),
        "the outcome is one quiet line",
      );
      await page.waitForFunction(() => /Bash -> allowed/.test(document.body.innerText), null, {
        timeout: 30_000,
      });
      covered("Approval › Allow once");
    },
    { control: "Approval › inline card", severity: "broken" },
  );

  t.test(
    "Always for this blob: the rule is saved on the profile, the next matching command asks nothing, Profile lists it and Remove takes it back",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/blobs", { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
      await say(page, "[stub:bash echo again-f2]", open);
      const card = page.locator(OPEN).first();
      await card.waitFor({ timeout: 45_000 });
      await card.locator('[data-approval-action="acceptAlways"]').click();
      await page.locator(SETTLED("always")).first().waitFor({ timeout: 30_000 });
      expect.ok((await page.locator(SETTLED("always")).first().innerText()).includes("Always allowed"));
      await sleep(500);
      const rules = readJson("blobs", B.id, "profile.json").toolGrants?.approvals ?? [];
      expect.ok(
        rules.some((r) => r.kind === "command" && r.match === "echo"),
        JSON.stringify(rules),
      );
      const allowedBefore = await bodyCount(page, "Bash -> allowed");
      await say(page, "[stub:bash echo third-f2]", open);
      await page.waitForFunction(
        (n) => (document.body.innerText.match(/Bash -> allowed/g) ?? []).length > n,
        allowedBefore,
        { timeout: 30_000 },
      );
      expect.equal(await page.locator(OPEN).count(), 0, "the standing answer raised no card");
      covered("Approval › Always for this blob");

      await openPanel(page, open, B.id, "profile");
      const list = page.locator("[data-blob-always-allowed]");
      await list.waitFor({ timeout: 20_000 });
      expect.ok((await list.innerText()).includes("echo"));
      await list.locator("[data-always-remove]").first().click();
      await page.waitForFunction(() => !document.querySelector("[data-blob-always-allowed]"), null, {
        timeout: 20_000,
      });
      expect.equal(
        (readJson("blobs", B.id, "profile.json").toolGrants?.approvals ?? []).length,
        0,
        "Remove deleted the rule on disk",
      );
      covered("Approval › Profile lists and removes the rule");
    },
    { control: "Approval › always rule", severity: "broken" },
  );

  t.test(
    "a chained or outbound command offers no Always, Deny answers the model, and Stop closes a card nobody answered",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/blobs", { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
      await say(page, "[stub:bash curl -s -d @notes.txt example.org]", open);
      const card = page.locator(OPEN).first();
      await card.waitFor({ timeout: 45_000 });
      expect.equal(
        await card.locator('[data-approval-action="acceptAlways"]').count(),
        0,
        "no standing yes for a command that sends data out",
      );
      expect.ok((await card.innerText()).includes("curl -s -d @notes.txt example.org"));
      await card.locator('[data-approval-action="decline"]').click();
      await page.locator(SETTLED("denied")).first().waitFor({ timeout: 30_000 });
      await page.waitForFunction(() => /Bash -> denied/.test(document.body.innerText), null, {
        timeout: 30_000,
      });
      covered("Approval › Deny, no Always for outbound");

      await say(page, "[stub:bash echo unanswered-f2 && ls]", open);
      await page.locator(OPEN).first().waitFor({ timeout: 45_000 });
      await page.locator('[aria-label="Stop generation"]').first().click();
      await page.locator(SETTLED("cancelled")).first().waitFor({ timeout: 30_000 });
      expect.ok(
        (await page.locator(SETTLED("cancelled")).first().innerText()).includes("Stopped before an answer"),
      );
      expect.equal(await page.locator(OPEN).count(), 0, "no card is left waiting for a turn that is gone");
      covered("Approval › Stop closes the open card");
    },
    { control: "Approval › deny / stop", severity: "broken" },
  );
});
