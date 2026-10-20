// "Log in to Claude" in the first-message setup card. QA stacks run with an empty CLAUDE_CONFIG_DIR, so the card says
// "not logged in" and (daemon ≥ 2026-10-02) offers the button. The daemon's /api/claude/login is mocked here: the
// real route runs `claude auth login`, which opens a browser on whoever runs the suite.
import { spec } from "../lib/harness.mjs";

spec("18-onboarding", { stack: 1 }, async (t) => {
  t.test(
    "a logged-out Mac gets Log in to Claude; waiting shows the sign-in link, code field and Cancel",
    async ({ page, open, expect, covered, sleep }) => {
      const posts = [];
      let phase = "idle";
      await page.route("**/api/claude/login", async (route) => {
        const req = route.request();
        if (req.method() === "POST") {
          const body = JSON.parse(req.postData() || "{}");
          posts.push(body);
          if (body.action === "start") phase = "waiting";
          if (body.action === "cancel") phase = "cancelled";
        }
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            phase,
            url: phase === "waiting" ? "https://claude.com/cai/oauth/authorize?code=true" : null,
            message: null,
            via: "bundled",
          }),
        });
      });
      await open("/");
      const start = page.locator('[data-claude-login="start"]');
      await start.waitFor({ timeout: 40_000 });
      covered("Setup card › Log in to Claude offered");
      await start.click();
      await page.locator('[data-claude-login="waiting"]').waitFor({ timeout: 10_000 });
      await expect.equal(await page.locator('[data-claude-login="open-page"]').count(), 1);
      await page.locator('[data-claude-login="code"]').fill("abc#def");
      await page.keyboard.press("Enter");
      await sleep(300);
      await expect.deepEqual(
        posts.find((p) => p.action === "code"),
        { action: "code", code: "abc#def" },
        "the pasted code is posted to the daemon",
      );
      await page.locator('[data-claude-login="cancel"]').click();
      await start.waitFor({ timeout: 5_000 });
      covered("Setup card › login waiting / code / cancel");
    },
    { control: "Setup card › Log in to Claude", severity: "broken" },
  );

  t.test(
    "a reload while the daemon still waits on the browser sign-in resumes the waiting state",
    async ({ page, open, expect, covered }) => {
      await page.route("**/api/claude/login", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            phase: "waiting",
            url: "https://claude.com/cai/oauth/authorize?code=true",
            message: null,
            via: "bundled",
          }),
        }),
      );
      await open("/");
      await page.locator('[data-claude-login="waiting"]').first().waitFor({ timeout: 40_000 });
      await expect.equal(
        await page.locator('[data-claude-login="start"]').count(),
        0,
        "no fresh Log in button while a login is running",
      );
      covered("Login › resumes a running sign-in after reload");
    },
    { control: "Login › resume after reload", severity: "wrong" },
  );
});
