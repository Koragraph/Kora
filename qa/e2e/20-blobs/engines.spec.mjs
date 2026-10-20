// 20-blobs: Settings > Engines and the engines it adds (Phase 7), end to end through the real daemon + UI + drivers.
//   - the page lists every engine; one that cannot run is a row with its reason
//   - an API endpoint: add -> Test (rejected key sentence) -> key -> Test (Connected) -> Models -> a blob on it -> a real chat turn
//     over HTTP to a local fake OpenAI server; the key is in the secret store, never in engines.json or the page
//   - an ACP agent: point a built-in row at the scripted fake agent -> Ready -> a blob on it -> a chat turn; an edit outside the
//     blob's folders asks in the transcript (Deny -> the agent is told no)
//   - a second Claude account: Add -> the sign-in command to copy -> a blob on it shows the account chip in its header
// Nothing reaches a model or a network: the two engines are local fixtures (qa/e2e/20-blobs/fakeProviders.mjs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spec } from "../lib/harness.mjs";
import { STACK, home } from "./blobUi.mjs";
import { fakeAcpAgent, startFakeOpenAI } from "./fakeProviders.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, "../../../docs/bots/assets");
const stamp = Date.now().toString(36).slice(-4);

async function shot(page, name) {
  fs.mkdirSync(ASSETS, { recursive: true });
  await page.screenshot({ path: path.join(ASSETS, `i4b-${name}.png`) });
}

async function openEngines(page, open) {
  await open("/settings/engines", { wait: false });
  await page.locator("[data-engines-builtin]").waitFor({ timeout: 60_000 });
}

/** Hire a blob through the editor on a given engine tab + model row of the picker. */
async function hireOn(page, open, name, tab, modelText) {
  await open("/blobs", { wait: false });
  await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
  await page.locator("[data-new-blob], [data-blobs-empty] button").first().click();
  await page.locator("[data-blob-editor]").waitFor();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.locator('[data-editor-section="model"]').click();
  await page.locator('[data-model-mode="pick"]').click();
  await page.locator("[data-blob-editor] [data-agent-model-picker]").first().click();
  const pill = page.locator(`[data-model-picker-agent="${tab}"]`);
  await pill.scrollIntoViewIfNeeded(); // the provider row scrolls sideways when there are many engines
  await page.waitForTimeout(300);
  await pill.click();
  await page.getByText(modelText, { exact: true }).first().click();
  await page.locator('[data-editor-section="permissions"]').click();
  await page.locator('[data-permission="auto"]').click();
  await page.locator("[data-editor-save]").click();
  await page
    .locator(`[data-blob-id] [data-blob-row][aria-label^="${name}"]`)
    .first()
    .waitFor({ timeout: 25_000 });
  await page
    .waitForFunction(() => /^\/(draft|kora-local)\//.test(location.pathname), null, {
      timeout: 30_000,
    })
    .catch(() => {});
  await page.waitForTimeout(800);
}

async function say(page, name, text) {
  await page.locator(`[data-blob-id] [data-blob-row][aria-label^="${name}"]`).first().click();
  const box = page.locator('[contenteditable="true"]').last();
  await box.waitFor({ timeout: 30_000 });
  await box.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

const bodyHas = (page, text, timeout = 45_000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });
const bodyMatches = (page, source, timeout = 45_000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), source, { timeout });

let fake = null;
let tmp = null;

/** Every run starts from "nothing set up": the daemon reads these files on every call, so removing them is enough. */
function resetEngineState() {
  for (const f of ["engines.json", "claude-accounts.json"])
    fs.rmSync(path.join(home(), f), { force: true });
  for (const d of ["engine-secrets", "accounts"])
    fs.rmSync(path.join(home(), d), { recursive: true, force: true });
}

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "Settings > Engines lists the built-in engines, the accounts, the ACP agents (not-installed ones behind one line) and the API presets",
    async ({ page, open, expect, covered }) => {
      resetEngineState();
      await openEngines(page, open);
      for (const s of ["builtin", "accounts", "acp", "api"])
        await page.locator(`[data-engines-${s}]`).waitFor();
      const text = await page.locator("main").innerText();
      expect.match(text, /Claude/);
      expect.match(text, /Codex/);
      expect.match(text, /OpenCode/);
      expect.match(text, /Agent Client Protocol/);
      expect.match(text, /Close idle agents after/);
      expect.match(text, /Bring your own provider/);
      const toggle = page.locator("[data-acp-show-all]");
      if (await toggle.count()) {
        await toggle.click();
        // an agent that is not installed is a row with the sentence, not a missing row
        expect.match(
          await page.locator("[data-acp-row]").last().innerText(),
          /not found on this Mac|Ready/,
        );
      }
      for (const preset of [
        "openrouter",
        "deepseek",
        "groq",
        "lmstudio",
        "ollama",
        "anthropic-api",
      ])
        expect.ok(await page.locator(`[data-api-preset="${preset}"]`).count(), `preset ${preset}`);
      covered("engines page sections");
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, "engines-page");
    },
  );

  t.test(
    "an API endpoint: add, Test (bad key then good key), Models, a blob on it answers over HTTP; the key never leaves the secret store",
    async ({ page, open, expect, covered }) => {
      resetEngineState();
      fake = await startFakeOpenAI();
      await openEngines(page, open);
      await page.locator("[data-api-add-toggle]").click();
      await page.locator("[data-api-name]").fill("Fake AI");
      await page.locator("[data-api-url]").fill(fake.url);
      await page.locator("[data-api-create]").click();
      const row = page.locator('[data-api-row="fake-ai"]');
      await row.waitFor({ timeout: 20_000 });
      // a bad URL is a sentence in the form, not a crash
      await page.locator("[data-api-add-toggle]").click();
      await page.locator("[data-api-name]").fill("Bad");
      await page.locator("[data-api-url]").fill("http://api.example.com/v1");
      await page.locator("[data-api-create]").click();
      expect.match(await page.locator("[data-api-error]").innerText(), /https/);
      await page.getByRole("button", { name: "Cancel" }).last().click();

      await row.locator("[data-api-test]").click();
      await row.locator("[data-api-result]").waitFor();
      expect.match(await row.locator("[data-api-result]").innerText(), /rejected the API key/);
      await row.locator("[data-api-key]").fill(fake.key);
      await row.locator("[data-api-test]").click();
      await page.waitForFunction(
        (sel) =>
          /Connected\. 2 models available\./.test(document.querySelector(sel)?.textContent ?? ""),
        '[data-api-row="fake-ai"] [data-api-result]',
      );
      expect.ok(
        fake.seen.every((s) => s.method === "GET" && s.url.endsWith("/models")),
        "Test sends no chat message",
      );
      await row.locator("[data-api-key-save]").click();
      await page.waitForFunction(() =>
        /key saved/.test(document.querySelector('[data-api-row="fake-ai"]')?.textContent ?? ""),
      );
      await row.locator("[data-api-models]").click();
      expect.match(
        await row.locator("[data-api-models-result]").innerText(),
        /fake-small, fake-large/,
      );
      expect.ok(!(await page.content()).includes(fake.key), "the key is not on the page");
      const cfg = fs.readFileSync(path.join(home(), "engines.json"), "utf8");
      expect.ok(!cfg.includes(fake.key), "the key is not in engines.json");
      expect.ok(cfg.includes("fake-ai"));
      const secret = path.join(home(), "engine-secrets", "api-fake-ai");
      expect.equal(
        fs.readFileSync(secret, "utf8").trim(),
        fake.key,
        "the key is in the secret store",
      );
      expect.equal(fs.statSync(secret).mode & 0o777, 0o600);
      covered("api endpoint add/test/key/models");
      // a preset added without a key stays listed, unavailable, with the reason (the picker greys it)
      await page.locator('[data-api-preset="groq"]').click();
      await page.locator("[data-api-create]").click();
      await page.locator('[data-api-row="groq"]').waitFor({ timeout: 15_000 });
      expect.match(await page.locator('[data-api-row="groq"]').innerText(), /Needs an API key/);
      await row.scrollIntoViewIfNeeded();
      await shot(page, "engines-api");

      // a blob on the endpoint, a real turn
      const name = `Fako${stamp}`;
      await hireOn(page, open, name, "api-fake-ai", "fake-small");
      await shot(page, "picker-api-group");
      await say(page, name, "hello there from the QA");
      await bodyMatches(page, "Fake AI heard:.*hello there from the QA"); // the daemon adds the blob's memory context before the words
      const chat = fake.seen.find((s) => s.method === "POST");
      expect.ok(chat, "the turn reached the endpoint");
      expect.equal(chat.auth, `Bearer ${fake.key}`);
      expect.equal(JSON.parse(chat.body).model, "fake-small");
      covered("api driver chat through the UI");
      await shot(page, "api-chat");
    },
  );

  t.test(
    "an ACP agent: a built-in row pointed at the scripted agent becomes Ready, a blob on it answers, an edit outside its folders asks in the transcript",
    async ({ page, open, expect, covered }) => {
      tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "qa-acp-"));
      await openEngines(page, open);
      const toggle = page.locator("[data-acp-show-all]");
      if (await toggle.count()) await toggle.click();
      const row = page.locator('[data-acp-row="acp-hermes"]');
      await row.getByRole("button", { name: "Edit" }).click();
      await row.getByLabel("Hermes path").fill(process.execPath);
      await row.getByLabel("Hermes arguments").fill(fakeAcpAgent());
      await row.locator("[data-acp-save]").click();
      await page.waitForFunction(
        () =>
          /Ready/.test(document.querySelector('[data-acp-row="acp-hermes"]')?.textContent ?? ""),
        null,
        { timeout: 20_000 },
      );
      await row.locator("[data-acp-models]").click();
      await row.locator("[data-acp-models-result]").waitFor({ timeout: 40_000 });
      covered("acp agent path/args/models");
      await row.scrollIntoViewIfNeeded();
      await shot(page, "engines-acp");

      const name = `Acpy${stamp}`;
      await hireOn(page, open, name, "acp-hermes", "Model One");
      await say(page, name, "hello");
      await bodyHas(page, "Hello from", 60_000);
      covered("acp driver chat through the UI");
      await shot(page, "acp-chat");

      // Auto: a write outside the blob's folders asks, in the transcript, with the three buttons
      const outside = path.join(tmp, "outside.txt");
      const box = page.locator('[contenteditable="true"]').last();
      await box.click();
      await page.keyboard.type(`edit ${outside}`);
      await page.keyboard.press("Enter");
      const card = page.locator('[data-blob-card="approval"][data-approval-state="open"]').first();
      await card.waitFor({ timeout: 45_000 });
      await shot(page, "acp-approval");
      await card.getByRole("button", { name: /Deny/ }).click();
      await bodyHas(page, "rejected", 30_000);
      expect.ok(!fs.existsSync(outside), "the file outside the folders was never written");
    },
  );

  t.test(
    "a second Claude account: Add shows the sign-in command to copy (an empty folder, no login copied); a blob on it wears the account in its header",
    async ({ page, open, expect, covered }) => {
      await openEngines(page, open);
      await page.locator("[data-account-add-toggle]").click();
      await page.locator("[data-account-name]").fill("Work");
      await page.locator("[data-account-create]").click();
      const row = page.locator('[data-account-row="work"]');
      await row.waitFor({ timeout: 20_000 });
      const cmd = await row.locator("[data-sign-in-command]").innerText();
      expect.match(cmd, /^CLAUDE_CONFIG_DIR='.*accounts\/claude\/work' claude auth login$/);
      expect.ok(!/HOME=/.test(cmd), "never a fake HOME");
      expect.match(await row.innerText(), /Not signed in yet/);
      const dir = /CLAUDE_CONFIG_DIR='([^']+)'/.exec(cmd)[1];
      // the Claude CLI sets up its own config files when asked for the sign-in status; Kora copies no login and no history into it
      const made = fs.readdirSync(dir);
      expect.ok(
        !made.includes(".credentials.json") &&
          !made.includes("projects") &&
          !made.includes("settings.json"),
        `no login or history copied (${made.join(", ")})`,
      );
      await row.getByRole("button", { name: "Copy" }).click();
      expect.equal(await page.evaluate(() => navigator.clipboard.readText()), cmd);
      await row.locator("[data-account-check]").click();
      covered("claude account add/copy/check");
      await shot(page, "engines-accounts");

      const name = `Dual${stamp}`;
      await hireOn(page, open, name, "claude-work", "Sonnet 5.5");
      await page.locator("[data-account-chip]").first().waitFor({ timeout: 20_000 });
      expect.equal((await page.locator("[data-account-chip]").first().innerText()).trim(), "Work");
      covered("account chip in the blob header");
      await shot(page, "account-chip");
    },
  );

  t.test(
    "the model picker offers every engine as its own tab; an engine that cannot run is greyed with its reason",
    async ({ page, open, expect }) => {
      await open("/blobs", { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 40_000 });
      await page.locator("[data-new-blob], [data-blobs-empty] button").first().click();
      await page.locator("[data-blob-editor]").waitFor();
      await page.locator('[data-editor-section="model"]').click();
      await page.locator('[data-model-mode="pick"]').click();
      await page.locator("[data-blob-editor] [data-agent-model-picker]").first().click();
      const tabs = await page
        .locator("[data-model-picker-agent]")
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-model-picker-agent")));
      for (const want of [
        "claude",
        "codex",
        "claude-work",
        "api-fake-ai",
        "acp-hermes",
        "api-groq",
      ])
        expect.ok(tabs.includes(want), `${want} tab (${tabs.join(", ")})`);
      // Groq has no key: its tab is there, greyed, and says why
      const groq = page.locator('[data-model-picker-agent="api-groq"]');
      expect.ok(await groq.isDisabled(), "greyed: it cannot be picked");
      expect.match((await groq.getAttribute("aria-label")) ?? "", /needs an API key/i);
      await shot(page, "picker-groups");
      // the provider row scrolls sideways: show the far end too (ACP and API groups sit there)
      await page.locator("[data-model-picker-nav]").evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      await page.waitForTimeout(300);
      await shot(page, "picker-groups-more");
    },
  );

  // the fixtures are servers: close them, or this process never exits
  t.test("cleanup: the fake OpenAI server and the temp folder go", async ({ expect }) => {
    await fake?.close();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    expect.ok(true);
  });
});
