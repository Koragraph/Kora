// 20-blobs: group chats end to end (docs/bots/GROUPS.md). A group is ONE transcript; every member answers from its own provider
// session (the QA stub engine, no model): who answers (mention / auto / lead / @all), author names on the bubbles, the "to Popo,
// Junip" label, a per-member timeout note, an approval raised by one member answered in the group, Stop, a daemon restart, retiring
// a member and deleting the group. Run: KORA_QA_BLOBS_STACK=1 node qa/e2e/20-blobs/groups.spec.mjs
//
// Directives the stub engine understands in a group turn (packages/runtime/src/session/qa-stub-query.ts):
//   [pick:Junip]               the (stub) auto picker chooses that member
//   [stub:say@Popo text]       only Popo answers with exactly this text
//   [stub:slow@Junip 9000]     only Junip takes 9 s (the stack cuts a member off after 4 s)
//   [stub:bash@Popo <cmd>]     only Popo asks for one shell command (an approval card waits in the GROUP)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spec } from "../lib/harness.mjs";
import { loadBlob } from "./blobSeed.mjs";
import { STACK, createBlob, home } from "./blobUi.mjs";

const ASSETS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/bots/assets",
);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ctl = (cmd) =>
  execFileSync(process.execPath, [path.join(ROOT, "qa/stacks/stack.cjs"), cmd, String(STACK)], {
    stdio: "ignore",
    timeout: 90_000,
  });
const GROUP = `crew-${Date.now().toString(36).slice(-4)}`;
const KORA = "blob_kora";
let popo;
let junip;
let groupId = null;

const author = (page, id) => page.locator(`[data-group-author="${id}"]`);
const lastBubbleText = async (page) =>
  (await page.locator("[data-blob-bubble='assistant']").last().innerText()).trim();

async function composer(page) {
  const box = page.locator('[contenteditable="true"]').last();
  await box.waitFor({ timeout: 30_000 });
  return box;
}
async function say(page, text) {
  const box = await composer(page);
  await box.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}
/** The open group thread's address, kept so later steps return to it. */
let threadPath = null;

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "set up: two blobs besides Kora",
    async ({ page, open }) => {
      for (const name of ["Popo", "Junip"]) {
        try {
          loadBlob(STACK, name);
        } catch {
          await createBlob(page, open, name);
        }
      }
      popo = loadBlob(STACK, "Popo");
      junip = loadBlob(STACK, "Junip");
      // An isolated stack has no signed-in engine, so a blob made by another spec (a starter, or Kora herself) may sit on the free
      // OpenCode model: a REAL call. Put all three on the stub-answered Claude lane (the daemon is down while profiles are written),
      // and Popo on Ask so a shell command raises an approval card.
      const files = [KORA, popo.id, junip.id].map((id) =>
        path.join(home(), "blobs", id, "profile.json"),
      );
      const profiles = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
      const needs =
        profiles.some((p) => p.engine.instanceId !== "claude") || profiles[1].permission !== "ask";
      if (needs) {
        ctl("stop");
        profiles.forEach((p, i) => {
          p.engine = { instanceId: "claude", model: "sonnet", effort: null };
          if (i === 1) p.permission = "ask";
          fs.writeFileSync(files[i], JSON.stringify(p, null, 2) + "\n");
        });
        ctl("start");
      }
    },
    { control: "Blobs › groups set up", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "New group: pick members, a lead, a rule; it lands in the roster and opens its chat",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/blobs", { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
      await page.locator("[data-new-group]").click();
      await page.locator("[data-group-dialog]").waitFor();
      // too few members: Create is refused with a message, nothing is made
      await page.locator("[data-group-name]").fill(GROUP);
      await page.locator("[data-group-name]").blur();
      await page.getByText("Pick at least 2 members.").first().waitFor();
      expect.ok(
        await page.locator("[data-group-submit]").isDisabled(),
        "Create is refused until there are two members",
      );
      for (const id of [KORA, popo.id, junip.id])
        await page.locator(`[data-member-option="${id}"]`).click();
      expect.equal(await page.locator("[data-member-count]").innerText(), "3 of 12");
      await page.locator('[data-rule-option="auto"]').click();
      await page.screenshot({ path: path.join(ASSETS, "i4a-group-create.png") });
      await page.locator("[data-group-submit]").click();
      await page.locator("[data-group-dialog]").waitFor({ state: "detached", timeout: 15_000 });
      // on disk: a real group with the lead defaulting to Kora
      const dirs = fs
        .readdirSync(path.join(home(), "groups"))
        .filter((d) => d.startsWith("group_"));
      const profiles = dirs.map((d) =>
        JSON.parse(fs.readFileSync(path.join(home(), "groups", d, "group.json"), "utf8")),
      );
      const g = profiles.find((p) => p.name === GROUP);
      expect.ok(g, "group.json written");
      expect.equal(g.leadId, KORA);
      expect.deepEqual([...g.memberIds].sort(), [KORA, popo.id, junip.id].sort());
      expect.ok(fs.existsSync(path.join(g.workspace, "outputs")), "the shared folder exists");
      // the roster row and the header
      await page.locator(`[data-group-id="${g.id}"] [data-group-row]`).waitFor();
      await page.locator("[data-group-header-name]").waitFor({ timeout: 30_000 });
      expect.equal((await page.locator("[data-group-header-name]").innerText()).trim(), GROUP);
      expect.ok(
        (await page.locator("[data-group-header-identity] [data-group-member]").count()) === 3,
      );
      await page
        .waitForFunction(() => /^\/(draft|kora-local)\//.test(location.pathname), null, {
          timeout: 30_000,
        })
        .catch(() => {});
      groupId = g.id;
      covered("New group dialog", "validation, members, rule, lead default");
    },
    { control: "Blobs › New group", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "@Popo: only Popo answers, with his name on the bubble and 'to Popo' under yours; Kora (the lead) stays silent",
    async ({ page, open, sleep, expect }) => {
      await open(`/blobs/${groupId}`, { wait: false });
      await page.locator("[data-group-header-name]").waitFor({ timeout: 60_000 });
      await say(page, "@Popo hello there");
      await author(page, popo.id).first().waitFor({ timeout: 60_000 });
      await page
        .locator("[data-blob-bubble='assistant']")
        .filter({ hasText: "Popo here" })
        .waitFor({ timeout: 30_000 });
      await sleep(1500);
      expect.equal(await author(page, KORA).count(), 0, "the lead was not addressed");
      expect.equal(await author(page, junip.id).count(), 0);
      const label = page.locator("[data-routed-to]").last();
      expect.match(await label.innerText(), /to Popo/);
      expect.equal(await label.getAttribute("data-routed-to"), popo.id);
      await page.screenshot({ path: path.join(ASSETS, "i4a-group-chat.png") });
      await page.screenshot({
        path: path.join(ASSETS, "i4a-roster-groups.png"),
        clip: { x: 0, y: 0, width: 256, height: 900 },
      });
    },
    { control: "Blobs › group @mention routing", severity: "broken", ignoreErrors: true },
  );

  const openGroup = async (page, open) => {
    await open(`/blobs/${groupId}`, { wait: false });
    await page.locator("[data-group-header-name]").waitFor({ timeout: 60_000 });
    await composer(page);
  };
  const repliers = async (page, markerBefore) => {
    // ids of the authors of the assistant bubbles added after `markerBefore` bubbles
    return page.evaluate(
      (n) =>
        [...document.querySelectorAll("[data-group-author]")]
          .slice(n)
          .map((e) => e.getAttribute("data-group-author")),
      markerBefore,
    );
  };

  t.test(
    "auto rule: the quick model's pick answers alone; with no pick the lead answers and the label says so",
    async ({ page, open, sleep, expect }) => {
      await openGroup(page, open);
      const before = await author(page, popo.id).count();
      await say(page, "crunch the numbers [pick:Junip]");
      await page
        .locator("[data-blob-bubble='assistant']")
        .filter({ hasText: "Junip here" })
        .waitFor({ timeout: 60_000 });
      const label = page.locator("[data-routed-to]").last();
      expect.match(await label.innerText(), /to Junip/);
      expect.match(await label.innerText(), /picked for you/);
      expect.equal(await author(page, popo.id).count(), before, "Popo stayed quiet");
      await say(page, "what should we do next?");
      await page
        .locator("[data-blob-bubble='assistant']")
        .filter({ hasText: "Kora here" })
        .waitFor({ timeout: 60_000 });
      const label2 = page.locator("[data-routed-to]").last();
      expect.match(await label2.innerText(), /to Kora/);
      expect.match(await label2.innerText(), /the lead took it/);
    },
    { control: "Blobs › group auto rule", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "@all: every member answers (the lead included, she is a member); each bubble wears its own author",
    async ({ page, open, sleep, expect }) => {
      await openGroup(page, open);
      await say(page, "@all quick status");
      for (const who of ["Kora here", "Popo here", "Junip here"])
        await page
          .locator("[data-blob-bubble='assistant']")
          .filter({ hasText: `${who}: all quick status` })
          .waitFor({ timeout: 60_000 });
      const label = page.locator("[data-routed-to]").last();
      expect.match(
        await label.innerText(),
        /to .*Kora.*Popo.*Junip|to .*Popo.*Junip.*Kora|to Kora, Popo and Junip/,
      );
      for (const id of [KORA, popo.id, junip.id]) expect.ok((await author(page, id).count()) >= 1);
      // Live QA #4 reported a duplicated @all timestamp: not reproducible. Guard it - at most one time stamp per message, none stacked in a row.
      const stamps = await page.evaluate(() =>
        [...document.querySelectorAll("[data-message-time]")].map((e) =>
          e.getAttribute("data-message-time"),
        ),
      );
      expect.equal(new Set(stamps).size, stamps.length, "no message carries two timestamps");
      expect.ok(
        stamps.length <= (await page.locator("[data-blob-bubble='assistant']").count()),
        "never more timestamps than replies",
      );
    },
    { control: "Blobs › group @all", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "a slow member is cut off with a note; the others are not blocked",
    async ({ page, open, sleep, expect }) => {
      await openGroup(page, open);
      await say(page, "@Popo @Junip report [stub:slow@Junip 15000] [stub:say@Popo done early]");
      await page
        .locator("[data-blob-bubble='assistant']")
        .filter({ hasText: "done early" })
        .waitFor({ timeout: 60_000 });
      await page
        .locator("[data-group-note]")
        .filter({ hasText: "Junip is taking too long" })
        .waitFor({ timeout: 40_000 });
      await page.screenshot({ path: path.join(ASSETS, "i4a-group-timeout.png") });
      // the group is usable at once afterwards
      await say(page, "@Junip are you back? [stub:say@Junip yes]");
      await page
        .locator("[data-blob-bubble='assistant']")
        .filter({ hasText: /^yes$/ })
        .waitFor({ timeout: 60_000 });
    },
    { control: "Blobs › group member timeout", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "an approval one member raises is a card in the group (named, with the command); Allow once lets it finish",
    async ({ page, open, sleep, expect }) => {
      await openGroup(page, open);
      await say(page, "@Popo run it [stub:bash@Popo touch scratch.txt]");
      const card = page.locator('[data-blob-card="approval"][data-approval-state="open"]').first();
      await card.waitFor({ timeout: 60_000 });
      expect.match(await card.innerText(), /touch scratch\.txt/);
      expect.match(
        await card.innerText(),
        /Popo wants to/,
        "the card names the member that asks, not the group",
      );
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(ASSETS, "i4a-group-approval.png") });
      await card.locator('[data-approval-action="accept"]').click();
      await page
        .locator("[data-blob-bubble='assistant']")
        .filter({ hasText: /Bash -> allowed/ })
        .waitFor({ timeout: 60_000 });
    },
    { control: "Blobs › group approval card", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "rule When mentioned: nobody answers an un-addressed message and the label says how to get a reply",
    async ({ page, open, sleep, expect }) => {
      await openGroup(page, open);
      await page.locator("[data-rule-chip]").click();
      await page.getByRole("radio", { name: /When mentioned/ }).click();
      await sleep(600);
      await say(page, "is anyone there?");
      await page
        .locator("[data-routed-to]")
        .filter({ hasText: /mention someone/i })
        .last()
        .waitFor({ timeout: 30_000 });
      await sleep(2500);
      // the thread's own record (the transcript list is virtualised, so counting bubbles on screen proves nothing)
      const dir = path.join(home(), "kora-daemon", "threads");
      const threads = fs
        .readdirSync(dir)
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
        .filter((t) => t.projectId === groupId);
      const mine = threads.find((t) => t.messages.some((m) => m.text === "is anyone there?"));
      expect.ok(mine, "the message reached the thread");
      expect.equal(mine.messages.at(-1).text, "is anyone there?", "nobody answered it");
      expect.deepEqual(mine.messages.at(-1).to, [], "and it went to nobody");
      const g = JSON.parse(
        fs.readFileSync(path.join(home(), "groups", groupId, "group.json"), "utf8"),
      );
      expect.equal(g.rule, "mention");
    },
    { control: "Blobs › group rule chip", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "the @ menu offers the group's members and @all, not files",
    async ({ page, open, expect }) => {
      await openGroup(page, open);
      const box = await composer(page);
      await box.click();
      await page.keyboard.type("@");
      await page.locator("[data-prompt-command-drawer]").waitFor({ timeout: 15_000 });
      const items = await page.locator("[data-prompt-item-id]").allInnerTexts();
      const joined = items.join(" | ");
      expect.match(joined, /@Popo/);
      expect.match(joined, /@Junip/);
      expect.match(joined, /@Kora/);
      expect.match(joined, /@all/);
      await page.locator("[data-prompt-item-id='group-member:Junip']").click();
      expect.match(await box.innerText(), /Junip/);
      await page.keyboard.press("Escape");
    },
    { control: "Blobs › group @ menu", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "Stop ends the member turns quietly (no 'taking too long' note) and the group answers again right after",
    async ({ page, open, sleep, expect }) => {
      await openGroup(page, open);
      await say(page, "@Popo slow one [stub:slow@Popo 30000]");
      await page.locator("[data-blob-typing]").first().waitFor({ timeout: 30_000 });
      const notesBefore = await page.locator("[data-group-note]").count();
      await page.getByRole("button", { name: /stop/i }).first().click();
      await page.locator("[data-blob-typing]").waitFor({ state: "detached", timeout: 20_000 });
      await sleep(1500);
      expect.equal(
        await page.locator("[data-group-note]").count(),
        notesBefore,
        "a stop leaves no note: it is not a timeout and not a failure",
      );
      await say(page, "@Popo ready? [stub:say@Popo yes ready]");
      await page
        .locator("[data-blob-bubble='assistant']")
        .filter({ hasText: "yes ready" })
        .waitFor({ timeout: 40_000 });
    },
    { control: "Blobs › group Stop", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "a daemon restart keeps the group, its thread and its members' memory of the thread: the next message is answered",
    async ({ page, open, sleep, expect }) => {
      ctl("stop");
      ctl("start");
      await sleep(8000);
      await openGroup(page, open);
      // earlier messages are still there
      expect.ok((await page.locator("[data-blob-bubble='assistant']").count()) >= 3);
      await say(page, "@Junip after the restart [stub:say@Junip back and answering]");
      await page
        .locator("[data-blob-bubble='assistant']")
        .filter({ hasText: "back and answering" })
        .waitFor({ timeout: 60_000 });
      // the member sessions were re-linked: still ONE hidden thread per member for this group thread
      const dir = path.join(home(), "kora-daemon", "threads");
      const files = fs
        .readdirSync(dir)
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
      const groupThread = files.find((t) => t.projectId === groupId);
      const mine = files.filter(
        (t) =>
          t.origin?.kind === "group" &&
          t.origin.groupThreadId === groupThread.threadId &&
          t.projectId === junip.id,
      );
      expect.equal(mine.length, 1, "Junip still has exactly one session for this group thread");
    },
    { control: "Blobs › group survives a restart", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "delete a group: the confirm needs its exact name; its folder goes to the Trash; the blobs and their own folders are untouched",
    async ({ page, open, sleep, expect }) => {
      await open("/blobs", { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
      // a throwaway group so the main one stays for the other tests
      await page.locator("[data-new-group]").click();
      await page.locator("[data-group-dialog]").waitFor();
      const tmp = `tmp-${Date.now().toString(36).slice(-4)}`;
      await page.locator("[data-group-name]").fill(tmp);
      for (const id of [popo.id, junip.id])
        await page.locator(`[data-member-option="${id}"]`).click();
      await page.locator("[data-group-submit]").click();
      await page.locator("[data-group-dialog]").waitFor({ state: "detached", timeout: 15_000 });
      const read = () =>
        fs
          .readdirSync(path.join(home(), "groups"))
          .map((d) =>
            JSON.parse(fs.readFileSync(path.join(home(), "groups", d, "group.json"), "utf8")),
          )
          .find((x) => x.name === tmp);
      const g = read();
      expect.ok(g && fs.existsSync(g.workspace), "the group and its folder exist");
      const row = page.locator(`[data-group-id="${g.id}"]`);
      await row.waitFor();
      await row.click({ button: "right" });
      await page.getByRole("button", { name: /^Delete/ }).click();
      const dialog = page.locator("[data-group-delete-dialog]");
      await dialog.waitFor();
      expect.ok(
        await page.locator("[data-group-delete-confirm]").isDisabled(),
        "Delete stays off until the name is typed",
      );
      await page.locator("[data-group-delete-input]").fill("not the name");
      expect.ok(await page.locator("[data-group-delete-confirm]").isDisabled());
      await page.screenshot({ path: path.join(ASSETS, "i4a-group-delete.png") });
      await page.locator("[data-group-delete-input]").fill(tmp);
      await page.locator("[data-group-delete-confirm]").click();
      await dialog.waitFor({ state: "detached", timeout: 15_000 });
      await row.waitFor({ state: "detached", timeout: 15_000 });
      expect.equal(read(), undefined, "group.json is gone");
      expect.ok(!fs.existsSync(g.workspace), "the shared folder left Blobs");
      const trash = path.join(path.dirname(home()), "Trash");
      expect.ok(
        fs.readdirSync(trash).some((n) => n.startsWith(path.basename(g.workspace))),
        "...for the stack's Trash",
      );
      expect.ok(
        fs.existsSync(popo.workspace) && fs.existsSync(junip.workspace),
        "the members' own folders are untouched",
      );
      expect.ok(
        loadBlob(STACK, "Popo") && loadBlob(STACK, "Junip"),
        "the blobs are still on the team",
      );
    },
    { control: "Blobs › group delete", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "retiring a member takes it out of the group; under two members the group is archived and leaves the roster",
    async ({ page, open, sleep, expect }) => {
      await open("/blobs", { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
      await page.locator("[data-new-group]").click();
      await page.locator("[data-group-dialog]").waitFor();
      const tmp = `duo-${Date.now().toString(36).slice(-4)}`;
      await page.locator("[data-group-name]").fill(tmp);
      for (const id of [popo.id, junip.id])
        await page.locator(`[data-member-option="${id}"]`).click();
      await page.locator("[data-group-submit]").click();
      await page.locator("[data-group-dialog]").waitFor({ state: "detached", timeout: 15_000 });
      const read = () =>
        fs
          .readdirSync(path.join(home(), "groups"))
          .map((d) =>
            JSON.parse(fs.readFileSync(path.join(home(), "groups", d, "group.json"), "utf8")),
          )
          .find((x) => x.name === tmp);
      const g = read();
      const junipRow = page.locator(`[data-blob-id="${junip.id}"] [data-blob-row]`).first();
      await junipRow.click({ button: "right" });
      await page
        .getByText(/^Retire…?$/)
        .first()
        .click();
      const confirm = page.getByRole("button", { name: /^(Retire|OK|Confirm|Yes)/ });
      if (
        await confirm
          .first()
          .isVisible()
          .catch(() => false)
      )
        await confirm.first().click();
      await page
        .locator(`[data-group-id="${g.id}"]`)
        .waitFor({ state: "detached", timeout: 20_000 });
      expect.ok(
        read().archivedAt != null,
        "a group under two members is archived, not a one-person chat",
      );
      expect.deepEqual(read().memberIds, [popo.id]);
      // put Junip back for whatever runs after this
      await page.getByRole("button", { name: /^Retired \(/ }).click();
      await page.getByRole("button", { name: "Rehire" }).first().click();
      await page
        .locator(`[data-blob-id="${junip.id}"] [data-blob-row]`)
        .first()
        .waitFor({ timeout: 15_000 });
    },
    { control: "Blobs › group prune on retire", severity: "broken", ignoreErrors: true },
  );
});
