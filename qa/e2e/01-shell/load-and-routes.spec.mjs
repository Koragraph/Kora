// 01-shell: cold load, routing (thread / unknown thread / unknown path), browser history, document title.
import { spec } from "../lib/harness.mjs";

spec("01-shell", { stack: 1 }, async (t) => {
  t.test(
    "cold load of / renders the sidebar and the draft landing",
    async ({ page, open, expect, covered }) => {
      await open("/");
      await expect.ok(
        /\/draft\//.test(page.url()),
        `expected a draft landing url, got ${page.url()}`,
      );
      await page.getByLabel("Search chats").waitFor({ timeout: 10_000 });
      await page.getByText("tiny-lib").first().waitFor({ timeout: 10_000 });
      // The first visit compiles the (large) chat view in the Vite dev server: ~6 s alone, past 10 s when the four
      // QA stacks cold-start together. The packaged app serves prebuilt assets.
      await page.locator('[contenteditable="true"]').first().waitFor({ timeout: 40_000 });
      covered("cold load: sidebar + draft landing");
    },
    { control: "cold load /", severity: "crash" },
  );

  t.test(
    "route /$hostId/$threadId opens a seeded thread",
    async ({ page, open, seed, expect, covered }) => {
      await open("/");
      const fixture = seed().threads.find((x) => x.title.startsWith("Fixture: rich"));
      await page.getByText("tiny-lib").first().click();
      await page.getByText(fixture.title).first().click();
      await page.getByText("Summary").first().waitFor({ timeout: 15_000 });
      expect.match(page.url(), /\/[^/]+\/[0-9a-f-]{36}$/);
      covered("route: /$hostId/$threadId", page.url());
    },
    { control: "route /$hostId/$threadId", severity: "broken" },
  );

  t.test(
    "route to an unknown thread id does not blank-screen",
    async ({ page, open, seed, expect, covered }) => {
      await open("/");
      const fixture = seed().threads.find((x) => x.title.startsWith("[a01] chat one"));
      await page.getByText("tiny-lib").first().click();
      await page.getByText(fixture.title).first().click();
      await page.waitForTimeout(1000);
      const match = page.url().match(/\/([^/]+)\/[^/]+$/);
      expect.ok(match, `could not read hostId from ${page.url()}`);
      const hostId = match[1];
      await page.goto(
        `${page.url().split("/").slice(0, 3).join("/")}/${hostId}/00000000-0000-0000-0000-000000000000`,
        {
          waitUntil: "domcontentloaded",
        },
      );
      // Missing threads redirect home to a fresh draft rather than showing a
      // dedicated not-found state (see _threads.$hostId.$threadId.tsx) — not
      // blank, so this only asserts the non-blank part of the checklist item.
      await page.getByText("Let's build something").first().waitFor({ timeout: 15_000 });
      const bodyText = await page.evaluate(() => document.body.innerText);
      expect.ok(
        bodyText.trim().length > 0,
        "page rendered no visible text for an unknown thread id",
      );
      covered("route: unknown thread id", `redirected to ${page.url()}`);
    },
    {
      control: "route /$hostId/$unknownThreadId",
      severity: "wrong",
      // The app looks the unknown thread id up and gets a 404 before it redirects home — that
      // lookup failure is the expected trigger for the "missing" render state, not a defect.
      allowNetwork: [/\/api\/chat\/threads\/00000000-0000-0000-0000-000000000000/],
      allowConsole: [/Failed to load resource.*404/],
    },
  );

  t.test(
    "unknown path shows a not-found state with a way back",
    async ({ page, open, expect, covered }) => {
      await open("/nope");
      await page.getByText("Nothing lives at this address").waitFor({ timeout: 10_000 });
      const goHome = page.getByRole("link", { name: "Back to threads" });
      await goHome.waitFor({ timeout: 5000 });
      covered("route: unknown path /nope");
      await goHome.click();
      await page.waitForTimeout(1000);
      expect.ok(
        !/\/nope/.test(page.url()),
        `Back to threads did not navigate away from /nope: ${page.url()}`,
      );
      covered("not-found: Back to threads link");
    },
    { control: "route /nope", severity: "broken" },
  );

  t.test(
    "browser back and forward move across thread, settings and thread again",
    async ({ page, open, seed, expect, covered }) => {
      await open("/");
      const fixture = seed().threads.find((x) => x.title.startsWith("[a01] chat one"));
      await page.getByText("tiny-lib").first().click();
      await page.getByText(fixture.title).first().click();
      await page.getByText(fixture.title, { exact: true }).first().waitFor({ timeout: 10_000 });
      const threadUrl = page.url();

      await page.getByLabel("Settings", { exact: true }).first().click();
      await page.waitForURL(/\/settings/, { timeout: 10_000 });
      const settingsUrl = page.url();

      await page.goBack();
      await page.waitForTimeout(800);
      expect.equal(page.url(), threadUrl, "back from settings did not return to the thread");

      await page.goForward();
      await page.waitForTimeout(800);
      expect.equal(page.url(), settingsUrl, "forward did not return to settings");

      await page.goBack();
      await page.waitForTimeout(800);
      expect.equal(page.url(), threadUrl, "back a second time did not return to the thread");
      covered("browser history: thread -> settings -> back/forward");
    },
    { control: "browser back/forward", severity: "broken" },
  );

  t.test(
    "document.title stays the static app name across a thread and settings",
    async ({ page, open, seed, defect, covered }) => {
      await open("/");
      const homeTitle = await page.title();

      const fixture = seed().threads.find((x) => x.title.startsWith("Fixture: rich"));
      await page.getByText("tiny-lib").first().click();
      await page.getByText(fixture.title).first().click();
      await page.getByText("Summary").first().waitFor({ timeout: 15_000 });
      const threadTitle = await page.title();

      await page.getByLabel("Settings", { exact: true }).first().click();
      await page.waitForURL(/\/settings/, { timeout: 10_000 });
      const settingsTitle = await page.title();

      covered(
        "document.title across thread/settings",
        `home="${homeTitle}" thread="${threadTitle}" settings="${settingsTitle}"`,
      );
      if (threadTitle === homeTitle && settingsTitle === homeTitle) {
        await defect({
          control: "document.title",
          expected:
            "the browser tab title reflects the active thread's title and the current settings page, per the 01-shell checklist",
          actual: `document.title stayed "${homeTitle}" on the draft landing, on an open thread ("${fixture.title}"), and in Settings — it never changes from the static app name/version`,
          severity: "wrong",
        });
      }
    },
    { control: "Page title (document.title)", severity: "wrong" },
  );
});
