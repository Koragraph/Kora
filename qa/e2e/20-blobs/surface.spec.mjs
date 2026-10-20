// 20-blobs: the Kora | Code surface switcher, the /blobs landing, and the old Chat links/choice landing in Kora. No tokens are spent.
import { spec } from "../lib/harness.mjs";

const STACK = Number(process.env.KORA_QA_BLOBS_STACK ?? 2);

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "the titlebar switcher has Kora | Code and Kora lands on /blobs",
    async ({ page, open, sleep, expect, inkCheck, covered }) => {
      await open("/");
      const tabs = page.getByRole("tablist", { name: "Surface" });
      await tabs.waitFor({ timeout: 40_000 });
      const names = await tabs.getByRole("tab").allTextContents();
      expect.equal(names.join("|"), "Kora|Code");
      await tabs.getByRole("tab", { name: "Kora" }).click();
      await page.waitForURL(/\/blobs(\/|$)|\/[^/]+\/[0-9a-f-]{36}$/, { timeout: 20_000 });
      expect.equal(
        await tabs.getByRole("tab", { name: "Kora" }).getAttribute("aria-selected"),
        "true",
      );
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 30_000 });
      await sleep(300);
      const hues = (await inkCheck({ root: "[data-slot='sidebar']" })).filter(
        (h) => h.kind === "cold",
      );
      if (hues.length)
        throw new Error(`cold colours in the Blobs sidebar: ${JSON.stringify(hues)}`);
      covered("Blobs › switcher + landing + Ink sidebar");
    },
    { control: "Blobs › surface switcher", severity: "broken" },
  );

  t.test(
    "switching to Code and back works and the choice survives a reload",
    async ({ page, open, sleep, expect, covered }) => {
      await open("/");
      const tabs = page.getByRole("tablist", { name: "Surface" });
      await tabs.waitFor({ timeout: 40_000 });
      await tabs.getByRole("tab", { name: "Code" }).click();
      await sleep(800);
      expect.equal(
        await tabs.getByRole("tab", { name: "Code" }).getAttribute("aria-selected"),
        "true",
      );
      await tabs.getByRole("tab", { name: "Kora" }).click();
      await sleep(800);
      await page.reload({ waitUntil: "domcontentloaded" });
      await tabs.waitFor({ timeout: 40_000 });
      expect.equal(
        await tabs.getByRole("tab", { name: "Kora" }).getAttribute("aria-selected"),
        "true",
      );
      await tabs.getByRole("tab", { name: "Code" }).click();
      await sleep(800);
      expect.equal(
        await tabs.getByRole("tab", { name: "Code" }).getAttribute("aria-selected"),
        "true",
      );
      covered("Blobs › other surfaces unaffected, persistence");
    },
    { control: "Blobs › surface persistence", severity: "wrong" },
  );

  t.test(
    "the retired Chat surface lands in Kora: a stored 'chat' choice, /chat links and a Chat project link",
    async ({ page, open, sleep, expect, covered }) => {
      // The stored choice of a user who last used the Chat tab.
      await page.addInitScript(() => {
        try {
          if (!sessionStorage.getItem("qa-chat-seeded")) {
            localStorage.setItem("kora.surface.v1", JSON.stringify("chat"));
            sessionStorage.setItem("qa-chat-seeded", "1");
          }
        } catch {
          /* private mode */
        }
      });
      await open("/");
      const tabs = page.getByRole("tablist", { name: "Surface" });
      await tabs.waitFor({ timeout: 40_000 });
      await page.waitForURL(/\/blobs(\/|$)|\/[^/]+\/[0-9a-f-]{36}$/, { timeout: 30_000 });
      expect.equal(
        await tabs.getByRole("tab", { name: "Kora" }).getAttribute("aria-selected"),
        "true",
        "a stored 'chat' choice reads as Kora",
      );
      expect.equal(await tabs.getByRole("tab", { name: "Chat" }).count(), 0, "no Chat tab");
      // An old /chat link, and one into a project page that no longer exists.
      for (const old of ["/chat", "/chat/projects/anything", "/projects/local:chat-general"]) {
        await open(old, { wait: false });
        await page.waitForURL(/\/blobs(\/|$)|\/[^/]+\/[0-9a-f-]{36}$/, { timeout: 30_000 });
        await page
          .locator("[data-blobs-roster]")
          .first()
          .waitFor({ timeout: 40_000 })
          .catch(() => {
            throw new Error(`${old} did not land in Kora`);
          });
      }
      covered("Blobs › old Chat choice and links land in Kora");
    },
    { control: "Blobs › retired Chat surface redirects", severity: "wrong" },
  );
});
