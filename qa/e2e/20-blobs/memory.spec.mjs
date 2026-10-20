// 20-blobs: the Memory tab on a blob whose memory.db was seeded through the runtime's own memory module.
import { spec } from "../lib/harness.mjs";
import { loadBlob, seedBlobScenario, serveBlobFiles } from "./blobSeed.mjs";

const STACK = Number(process.env.KORA_QA_BLOBS_STACK ?? 2);
let scenario = null;

async function openMemory(page, open, sleep) {
  await serveBlobFiles(page, scenario.blob.workspace);
  await open(`/kora-local/${scenario.threadId}`, { wait: false });
  await page.locator("[data-blob-bubble='assistant']").first().waitFor({ timeout: 30_000 });
  const tab = page.locator('[data-blob-panel-tab="memory"]');
  if ((await tab.count()) === 0 || !(await tab.first().isVisible())) {
    await page.locator('button[aria-label*="panel" i]').first().click();
  }
  await page.locator('[data-blob-panel-tab="memory"]').click();
  await page.locator("[data-memory-tab]").waitFor({ timeout: 20_000 });
  await sleep(400);
}

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "set up: a blob with seeded memory",
    async ({ page, open, sleep }) => {
      await open("/blobs", { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 60_000 });
      await sleep(1500);
      let exists = true;
      try {
        loadBlob(STACK, "Popo");
      } catch {
        exists = false;
      }
      if (!exists) {
        await page.locator("[data-new-blob], [data-blobs-empty] button").first().click();
        await page.locator("[data-blob-editor]").waitFor();
        await page.getByLabel("Name", { exact: true }).fill("Popo");
        await page.locator("[data-editor-save]").click();
        // The blob's profile lands on disk before the roster repaints; wait on the disk, which is what seeding needs.
        for (let i = 0; i < 60; i += 1) {
          try {
            loadBlob(STACK, "Popo");
            break;
          } catch {
            await sleep(500);
          }
        }
      }
      scenario = await seedBlobScenario(STACK, "Popo");
    },
    { control: "Blobs › memory seed", severity: "broken", ignoreErrors: true },
  );

  t.test(
    "groups: About you, the blob's notes and Pending, with dates, sources and the disclosure line",
    async ({ page, open, sleep, expect, covered }) => {
      await openMemory(page, open, sleep);
      for (const group of ["pending", "you", "blob"]) {
        await page.locator(`[data-memory-group="${group}"]`).waitFor();
      }
      const you = page.locator('[data-memory-group="you"]');
      expect.ok((await you.innerText()).includes("cofounder named Sam"));
      expect.ok((await you.innerText()).includes("since"));
      expect.ok(
        (await page.locator("[data-memory-disclosure]").innerText())
          .toLowerCase()
          .includes("memory"),
      );
      covered("Blobs › memory groups");
    },
    { control: "Blobs › memory groups", severity: "broken", allowNetwork: [/api\/blobs/] },
  );

  t.test(
    "edit a fact inline, star it, search, then forget with Undo",
    async ({ page, open, sleep, expect, covered }) => {
      await openMemory(page, open, sleep);
      const row = page
        .locator("[data-memory-fact]")
        .filter({ hasText: "Prefers morning meetings" });
      await row.hover();
      await row.getByRole("button", { name: "Edit memory" }).click();
      const editor = page.getByLabel("Edit this memory");
      await editor.fill("Prefers morning meetings before 10 AM.");
      await editor.press("Enter");
      await page
        .locator("[data-memory-fact]")
        .filter({ hasText: "before 10 AM" })
        .waitFor({ timeout: 10_000 });

      const edited = page.locator("[data-memory-fact]").filter({ hasText: "before 10 AM" });
      await edited.hover();
      await edited.getByRole("button", { name: "Mark important" }).click();
      await page
        .locator("[data-memory-fact]")
        .filter({ hasText: "before 10 AM" })
        .getByRole("button", { name: "Not important" })
        .waitFor();

      await page.getByLabel("Search memory").fill("cofounder");
      expect.equal(await page.locator("[data-memory-fact]").count(), 1);
      await page.getByLabel("Search memory").fill("");

      const target = page
        .locator("[data-memory-fact]")
        .filter({ hasText: "You prefer short answers" });
      await target.hover();
      await target.getByRole("button", { name: "Forget memory" }).click();
      expect.equal(
        await page
          .locator("[data-memory-fact]")
          .filter({ hasText: "You prefer short answers" })
          .count(),
        0,
      );
      // The toast is mounted last; the transcript's own receipts also have Undo buttons.
      await page.getByRole("button", { name: "Undo" }).last().click();
      await page
        .locator("[data-memory-fact]")
        .filter({ hasText: "You prefer short answers" })
        .first()
        .waitFor();
      covered("Blobs › memory edit / star / search / forget-undo");
    },
    { control: "Blobs › memory edit", severity: "broken", allowNetwork: [/api\/blobs/] },
  );

  t.test(
    "pending memory: Approve moves it into About you",
    async ({ page, open, sleep, expect, covered }) => {
      await openMemory(page, open, sleep);
      const pending = page.locator('[data-memory-group="pending"]');
      await pending.getByRole("button", { name: "Approve" }).click();
      await page
        .locator('[data-memory-group="you"]')
        .getByText("caffeine")
        .waitFor({ timeout: 25_000 });
      expect.equal(await page.locator("[data-memory-pending]").count(), 0);
      covered("Blobs › memory pending approve");
    },
    { control: "Blobs › memory pending", severity: "broken", allowNetwork: [/api\/blobs/] },
  );

  t.test(
    "core notes can be edited",
    async ({ page, open, sleep, expect, covered }) => {
      await openMemory(page, open, sleep);
      await page.getByRole("button", { name: /Core notes/ }).click();
      const note = page.locator('[data-memory-core="you"]');
      await note.getByRole("button", { name: "Edit" }).click();
      await note
        .getByRole("textbox")
        .fill("Name: Sam\nTimezone: America/Chicago\nRole: founder\nLikes: short answers");
      await note.getByRole("button", { name: "Save" }).click();
      await note.getByText("Likes: short answers").waitFor({ timeout: 10_000 });
      expect.ok(true);
      covered("Blobs › memory core notes");
    },
    { control: "Blobs › memory core notes", severity: "broken", allowNetwork: [/api\/blobs/] },
  );
});
