// @effect-diagnostics nodeBuiltinImport:off - a QA script.
// Screenshots of the pixel sprite everywhere, into docs/bots/assets/sprite-*.png.
//   KORA_QA_DIR=<scratch> KORA_QA_CHROMIUM=<chrome> KORA_QA_BLOBS_STACK=N node qa/scripts/sprite-shots.mjs
// Needs a QA stack up (stack.cjs up N). The Chat-surface dock needs live fleet workers, so its sheet
// (sprite-sheet-*.png) was captured from a throwaway page that mounted the real SwarmBlob / LeadBlob / KoraMark.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { spec, seedOf } from "../e2e/lib/harness.mjs";
import { STACK, hireStarterOnDisk } from "../e2e/20-blobs/blobUi.mjs";
import { loadBlob } from "../e2e/20-blobs/blobSeed.mjs";

const HOST = "kora-local";
const OUT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../docs/bots/assets");

spec(
  "20-blobs-sprite-shots",
  { stack: STACK, viewport: { width: 1440, height: 900 } },
  async (t) => {
    t.test("screenshots", async ({ page, open, sleep }) => {
      NodeFS.mkdirSync(OUT, { recursive: true });
      const shot = (name) => page.screenshot({ path: NodePath.join(OUT, `sprite-${name}.png`) });
      for (const [id, name] of [
        ["tibbo", "Tibbo"],
        ["popo", "Popo"],
        ["dimp", "Dimp"],
        ["junip", "Junip"],
        ["bobble", "Bobble"],
        ["wobbo", "Wobbo"],
        ["mibble", "Mibble"],
      ])
        hireStarterOnDisk(id, name);

      // Blobs: roster + a chat
      const tibbo = loadBlob(STACK, "Tibbo");
      await open(`/blobs/${tibbo.id}`, { wait: false });
      await page.locator("[data-blobs-roster]").waitFor({ timeout: 60_000 });
      await sleep(2500);
      await shot("blobs-roster-chat");

      // sidebar logo + Code surface: a seeded thread with replies
      const seed = seedOf(STACK);
      const thread = seed.threads.find((x) => /rich transcript/.test(x.title)) ?? seed.threads[0];
      await open(`/${HOST}/${thread.id}`, { wait: false });
      await sleep(6000);
      await shot("code-thread");
    });
  },
);
