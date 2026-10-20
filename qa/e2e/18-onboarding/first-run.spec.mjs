// The first five minutes (night 2026-10-04, A1/A5/A6/A7/A11): the first-run screen (sign in → open a project → first
// message), one-click recent Claude Code folders, indexing as part of opening a project, and a new project's draft
// (starters, index line, Full access said once). QA stacks are signed out (empty CLAUDE_CONFIG_DIR).
//
// The welcome screen only exists while the Code surface has no project, so the first two tests need a FRESH stack:
//   node qa/stacks/stack.cjs reset 1 && node qa/stacks/stack.cjs up 1 && node qa/e2e/18-onboarding/first-run.spec.mjs
// On a seeded stack they record themselves as skipped (covered "… skipped: stack has projects") instead of failing.
// The recent-projects route is mocked (the real one reads ~/.claude.json, which a signed-in stack would expose).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { spec, stackOf } from "../lib/harness.mjs";

const s = stackOf(1);
const REPO = path.join(s.repos, "first-run-app");

function ensureFixtureRepo() {
  if (fs.existsSync(path.join(REPO, ".git"))) return;
  fs.mkdirSync(path.join(REPO, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(REPO, "src/greet.js"),
    "export const greet = (n) => `Hello, ${n}!`;\n",
  );
  fs.writeFileSync(path.join(REPO, "README.md"), "# first-run-app\n");
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.email=qa@kora.local",
        "-c",
        "user.name=Kora QA",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: REPO, stdio: "ignore" },
    );
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "initial");
}

async function onWelcome(page) {
  return page
    .waitForSelector("[data-first-run-welcome]", { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
}

spec("18-onboarding", { stack: 1 }, async (t) => {
  t.test(
    "first launch: one calm screen with three steps; sign-in is the next step and nothing is red",
    async ({ page, open, expect, covered, inkCheck }) => {
      await open("/");
      if (!(await onWelcome(page))) {
        covered("First run › welcome skipped: stack has projects");
        return;
      }
      await page.waitForSelector('[data-first-run-step="sign-in"][data-state="current"]', {
        timeout: 30_000,
      });
      expect.equal(await page.locator("main h1").first().innerText(), "Welcome to Kora");
      const steps = await page
        .locator("[data-first-run-step]")
        .evaluateAll((els) => els.map((e) => `${e.dataset.firstRunStep}:${e.dataset.state}`));
      expect.deepEqual(steps, ["sign-in:current", "project:later", "first-message:later"]);
      expect.equal(await page.locator('[data-claude-login="start"]').count(), 1, "Log in offered");
      const red = await page
        .locator("[data-first-run-welcome] .text-destructive")
        .filter({ visible: true })
        .count();
      expect.equal(red, 0, "no red before the user did anything");
      const cold = (await inkCheck({ root: "[data-first-run-welcome]" })).filter(
        (f) => f.kind === "cold",
      );
      expect.deepEqual(cold, [], "Ink palette: no cold hues");
      expect.ok(
        (await page.locator("[data-full-access-note]").count()) === 1,
        "the Full access default is said once",
      );
      covered("First run › three steps, sign-in current, calm");
    },
    { control: "First run › welcome", severity: "broken" },
  );

  t.test(
    "a recent Claude Code folder opens in one click, starts its index and lands in its first chat",
    async ({ page, open, expect, covered, sleep }) => {
      ensureFixtureRepo();
      await page.route("**/api/onboarding/recent-projects", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            projects: [
              {
                path: REPO,
                name: "first-run-app",
                displayPath: "~/first-run-app",
                isGitRepo: true,
              },
            ],
          }),
        }),
      );
      await open("/");
      if (!(await onWelcome(page))) {
        covered("First run › recents skipped: stack has projects");
        return;
      }
      await page.locator(`[data-first-run-recent="${REPO}"]`).click();
      await page.waitForFunction(() => location.pathname.startsWith("/draft"), null, {
        timeout: 30_000,
      });
      await page.waitForSelector("[data-draft-fresh-start]", { timeout: 40_000 });
      // The first index starts on open (a git repo): the line reaches "indexed" without any click.
      await page.waitForSelector('[data-draft-index-line="done"]', { timeout: 60_000 });
      const starters = page.locator("[data-draft-starter]");
      expect.equal(await starters.count(), 3, "three starter prompts");
      // The signed-out answer arrives with the health check: then the calm card shows and the starters wait.
      await page.waitForSelector('[data-setup-check="sign-in"]', { timeout: 30_000 });
      await sleep(300);
      expect.ok(await starters.first().isDisabled(), "starters wait for Claude's sign-in");
      covered("First run › recent folder → draft with starters + index done");
    },
    { control: "First run › recent projects", severity: "broken" },
  );

  t.test(
    "a new project's draft says Full access once; Got it hides it for good",
    async ({ page, open, expect, covered, sleep }) => {
      await open("/");
      const draft = await page
        .waitForSelector("[data-draft-fresh-start]", { timeout: 40_000 })
        .then(() => true)
        .catch(() => false);
      if (!draft) {
        covered("Draft › Full access note skipped: no fresh project draft");
        return;
      }
      const note = page.locator("[data-full-access-note]");
      if ((await note.count()) === 0) {
        covered("Draft › Full access note already dismissed");
        return;
      }
      await page.locator("[data-full-access-note-dismiss]").click();
      await sleep(300);
      expect.equal(await note.count(), 0, "dismissed");
      await page.reload();
      await page.waitForSelector("[data-draft-fresh-start]", { timeout: 40_000 });
      expect.equal(await page.locator("[data-full-access-note]").count(), 0, "stays dismissed");
      covered("Draft › Full access note once");
    },
    { control: "Draft › Full access note", severity: "wrong" },
  );

  t.test(
    "a Mac without Apple's developer tools: the project step says how to get git, calmly, with Check again",
    async ({ page, open, expect, covered }) => {
      // Mocked doctor (nothing is uninstalled): signed in, git missing.
      await page.route("**/api/doctor?**", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            koraVersion: "qa",
            platform: "darwin",
            cwd: null,
            generatedAt: Date.now(),
            checks: [
              { id: "daemon", label: "Kora daemon", status: "ok", detail: "Running", fix: null },
              { id: "claude-cli", label: "Claude Code", status: "ok", detail: "v2", fix: null },
              {
                id: "claude-auth",
                label: "Claude login",
                status: "ok",
                detail: "Signed in via claude.ai",
                fix: null,
              },
              {
                id: "git",
                label: "git",
                status: "warn",
                detail:
                  "Apple's command line developer tools are not installed, so git does not work yet. Chat works; the code graph, Swarm workers and worktrees need git.",
                fix: "In Terminal, run `xcode-select --install` (Apple's free command line tools, a short download), then come back to Kora.",
              },
            ],
          }),
        }),
      );
      await open("/");
      if (!(await onWelcome(page))) {
        covered("First run › developer tools skipped: stack has projects");
        return;
      }
      const card = page.locator("[data-first-run-git]");
      await card.waitFor({ timeout: 30_000 });
      await expect.match(await card.innerText(), /xcode-select --install/);
      await expect.equal(await page.locator("[data-first-run-git-recheck]").count(), 1);
      await expect.equal(
        await page.locator('[data-first-run-step="sign-in"]').getAttribute("data-state"),
        "done",
        "git never blocks the Claude step",
      );
      await expect.equal(await card.locator(".text-destructive").count(), 0, "calm, not red");
      covered("First run › missing developer tools (git)");
    },
    { control: "First run › developer tools", severity: "wrong" },
  );
});
