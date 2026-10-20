// 20-blobs: outside access end to end (docs/bots/OUTSIDE.md). Settings > Outside access creates a named token (shown ONCE, only its
// hash on disk), a REAL `kora mcp --team` process driven by the official MCP SDK client lists blobs, sends a message to a blob
// (the stub engine answers), waits for the reply and reads the thread; the transcript shows "via <client>"; the audit log lists
// every call (never the message text); Revoke is immediate and the next call is refused (and audited).
// Run: KORA_QA_BLOBS_STACK=1 node qa/e2e/20-blobs/outside.spec.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spec } from "../lib/harness.mjs";
import { loadBlob } from "./blobSeed.mjs";
import { STACK, createBlob, home } from "./blobUi.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const ASSETS = path.resolve(HERE, "../../../docs/bots/assets");
const ctl = (cmd) =>
  execFileSync(process.execPath, [path.join(ROOT, "qa/stacks/stack.cjs"), cmd, String(STACK)], {
    stdio: "ignore",
    timeout: 90_000,
  });
const CLIENT = `Claude Desktop ${Date.now().toString(36).slice(-3)}`;
let secret = null;
let popo;

function proof(phase) {
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [path.join(ROOT, "qa/scripts/outside-mcp-proof.mjs"), String(STACK), phase],
      {
        env: { ...process.env, KORA_TEAM_TOKEN: secret, MCP_CLIENT_NAME: CLIENT },
        encoding: "utf8",
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (e) {
    out = String(e.stdout ?? "");
    if (!out) throw e;
  }
  return JSON.parse(out.trim().split("\n").at(-1));
}

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "set up: a blob to talk to from outside",
    async ({ page, open }) => {
      try {
        loadBlob(STACK, "Popo");
      } catch {
        await createBlob(page, open, "Popo");
      }
      popo = loadBlob(STACK, "Popo");
      // the stub-answered Claude lane (a stack with no signed-in engine would otherwise put a blob on a real free model)
      const file = path.join(home(), "blobs", popo.id, "profile.json");
      const profile = JSON.parse(fs.readFileSync(file, "utf8"));
      if (profile.engine.instanceId !== "claude") {
        ctl("stop");
        profile.engine = { instanceId: "claude", model: "sonnet", effort: null };
        fs.writeFileSync(file, JSON.stringify(profile, null, 2) + "\n");
        ctl("start");
      }
    },
    { control: "Blobs › outside set up", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "the page: no tokens yet, config snippets per client, create a token (shown once), duplicate names refused",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/settings/outside", { wait: false });
      await page.locator("[data-outside]").waitFor({ timeout: 60_000 });
      await page.locator("[data-snippets]").waitFor();
      // the snippet is the exact launch line for THIS install
      await page.waitForFunction(
        () => !/Loading/.test(document.querySelector("[data-snippet]")?.textContent ?? "Loading"),
        null,
        { timeout: 30_000 },
      );
      const snippet = await page.locator("[data-snippet]").first().innerText();
      expect.match(snippet, /mcp/);
      expect.match(snippet, /--team/);
      expect.doesNotMatch(snippet, /kbo_/, "no token inside the snippet until one exists");
      // a blank name is refused
      await page.locator("[data-token-create]").click();
      expect.ok(await page.locator("[data-token-error]").isVisible(), "a name is required");
      await page.locator("[data-token-name]").fill(CLIENT);
      await page.locator("[data-token-create]").click();
      const reveal = page.locator("[data-token-reveal]");
      await reveal.waitFor({ timeout: 20_000 });
      secret = (await page.locator("[data-token-value]").innerText()).trim();
      expect.match(secret, /^kbo_[A-Za-z0-9_-]{20,}$/);
      await page.screenshot({ path: path.join(ASSETS, "i4a-outside-token.png") });
      // on disk only the hash: tokens.json holds no plaintext
      const file = path.join(home(), "blobs", "outside", "tokens.json");
      const raw = fs.readFileSync(file, "utf8");
      expect.ok(!raw.includes(secret), "the plaintext token is never stored");
      expect.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
      await page.locator("[data-token-done]").click();
      await reveal.waitFor({ state: "detached" });
      expect.ok(!(await page.content()).includes(secret), "the secret is gone after Done");
      await page.locator(`[data-token]`).filter({ hasText: CLIENT }).waitFor();
      // a second token with the same name is refused
      await page.locator("[data-token-name]").fill(CLIENT);
      await page.locator("[data-token-create]").click();
      await page.locator("[data-token-error]").waitFor();
      covered("Outside access page", "create once, snippets, duplicate refused");
    },
    { control: "Blobs › Outside access page", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "a real `kora mcp --team` + the official MCP SDK client: list, send, wait, read, search; forbidden and bad calls fail cleanly",
    async () => {
      const r = proof("live");
      const failed = r.checks.filter((c) => !c.ok);
      if (failed.length) throw new Error(`MCP proof failed: ${JSON.stringify(failed)}`);
      fs.writeFileSync(
        path.join(path.dirname(home()), "outside-proof.json"),
        JSON.stringify(r, null, 2),
      );
    },
    { control: "Blobs › MCP bridge live proof", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "the message that came through MCP reads 'via <client>' in the blob's chat, and the audit log lists the calls without their text",
    async ({ page, open, sleep, expect }) => {
      await open(`/blobs/${popo.id}`, { wait: false });
      // the blob's landing forwards to its newest thread: the one the MCP client started
      await page.locator("[data-via]").first().waitFor({ timeout: 60_000 });
      expect.match(
        await page.locator("[data-via]").first().innerText(),
        new RegExp(`via ${CLIENT}`),
      );
      await page.screenshot({ path: path.join(ASSETS, "i4a-outside-via.png") });
      await open("/settings/outside", { wait: false });
      await page.locator("[data-audit-row]").first().waitFor({ timeout: 30_000 });
      const rows = await page.locator("[data-audit-row]").allInnerTexts();
      const joined = rows.filter((r) => r.includes(CLIENT)).join("\n"); // this run's client (older runs' rows stay in the log)
      expect.match(joined, /Sent a message/);
      expect.match(joined, /Listed the team/);
      expect.match(joined, new RegExp(CLIENT));
      expect.doesNotMatch(joined, /hello from MCP/, "message text is never in the audit log");
      expect.doesNotMatch(joined, new RegExp(secret));
      await page.screenshot({ path: path.join(ASSETS, "i4a-outside-page.png") });
    },
    { control: "Blobs › outside via label + audit", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "Revoke is immediate: the next MCP call is refused and audited, the token moves to the revoked list",
    async ({ page, open, sleep, expect }) => {
      await open("/settings/outside", { wait: false });
      const row = page.locator("[data-token]").filter({ hasText: CLIENT });
      await row.waitFor({ timeout: 30_000 });
      await row.locator("[data-revoke]").click();
      await page.locator("[data-revoke-confirm]").click();
      await page
        .locator("[data-token-revoked]")
        .filter({ hasText: CLIENT })
        .waitFor({ timeout: 20_000 });
      const r = proof("revoked");
      const failed = r.checks.filter((c) => !c.ok);
      if (failed.length) throw new Error(`revoked proof failed: ${JSON.stringify(failed)}`);
      await page
        .locator("[data-audit-row][data-audit-ok='false']")
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(async () => {
          await page.getByRole("button", { name: "Refresh activity" }).click();
          await page
            .locator("[data-audit-row][data-audit-ok='false']")
            .first()
            .waitFor({ timeout: 20_000 });
        });
    },
    { control: "Blobs › outside revoke", severity: "broken", ignoreErrors: true },
  );
});
