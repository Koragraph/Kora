// 20-blobs: the Blobs surface speaks Blobs, not Code (live QA #2): posture names are Ask / Auto / Full everywhere, a blob chat never shows
// Swarm / orchestrator / worker wording, and the hand-off text Kora sends a blob stays behind a quiet row. No model is called.
import { spec } from "../lib/harness.mjs";
import { STACK, createBlob, openPanel } from "./blobUi.mjs";

const NAME = `Words${Date.now().toString(36).slice(-4)}`;
// words that belong to the Code surface (or to plumbing), never to a blob's chat
const FORBIDDEN =
  /swarm|orchestrat|worker updates|\[kora\]|supervised|auto-accept|accept edits|full access|sub-?agent/i;

spec("20-blobs", { stack: STACK }, async (t) => {
  t.test(
    "a blob chat: permission menu says Ask / Auto / Full, and no Swarm, orchestrator, worker or hand-off wording shows anywhere on the surface",
    async ({ page, open, sleep, expect, covered }) => {
      await sleep(8000); // the previous spec may have just restarted the daemon
      const blob = await createBlob(page, open, NAME);
      await page.locator(`[data-blob-id] [data-blob-row][aria-label^="${NAME}"]`).first().click();
      const box = page.locator('[contenteditable="true"]').last();
      await box.waitFor({ timeout: 40_000 });
      await box.click();
      await page.keyboard.type("Say hello in one line.");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => /Stub engine:/.test(document.body.innerText), null, {
        timeout: 45_000,
      });

      // the composer's permission menu
      let labels = null;
      const triggers = page.locator("[data-agent-model-picker]");
      for (let i = (await triggers.count()) - 1; i >= 0 && !labels; i -= 1) {
        await triggers.nth(i).click();
        const group = page.locator('[data-testid="model-picker-permissions"]');
        if (await group.isVisible().catch(() => false)) {
          labels = await group
            .locator("[data-permission-mode]")
            .evaluateAll((els) => els.map((e) => e.innerText.split("\n")[0].trim()));
          expect.ok(
            !FORBIDDEN.test(await group.innerText()),
            `menu copy: ${await group.innerText()}`,
          );
        }
        await page.keyboard.press("Escape");
      }
      expect.deepEqual(labels, ["Ask", "Auto", "Full"], "the blob's posture names");
      covered("Wording › composer permission menu");

      // the chat itself, then each side-panel tab
      expect.ok(!FORBIDDEN.test(await page.evaluate(() => document.body.innerText)), "chat text");
      for (const tab of ["profile", "memory", "files", "runs"]) {
        await openPanel(page, open, blob.id, tab);
        await sleep(600);
        const text = await page.evaluate(() => document.body.innerText);
        const hit = FORBIDDEN.exec(text);
        expect.ok(!hit, `the ${tab} tab says "${hit?.[0]}"`);
      }
      // the editor's Permissions section
      await openPanel(page, open, blob.id, "profile");
      await page.locator("[data-edit-blob]").click();
      await page.locator("[data-blob-editor]").waitFor();
      await page.locator('[data-editor-section="permissions"]').click();
      const editor = await page.locator('[role="dialog"]').last().innerText();
      expect.ok(!FORBIDDEN.test(editor), `editor: ${editor.slice(0, 200)}`);
      expect.ok(
        /Ask/.test(editor) && /Auto/.test(editor) && /Full/.test(editor),
        `editor text: ${editor.slice(0, 400)}`,
      );
      covered("Wording › editor, panel tabs and chat free of Code wording");
    },
    { control: "Wording › Blobs speak Blobs", severity: "wrong" },
  );
});
