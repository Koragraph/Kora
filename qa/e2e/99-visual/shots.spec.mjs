// Visual baseline: key screens at three widths -> $KORA_QA_SHOTS/<label>/<name>-<w>.png (compare with visual-diff.mjs).
import fs from "node:fs";
import path from "node:path";
import { spec } from "../lib/harness.mjs";

const STACK = Number(process.env.KORA_QA_STACK || 1);
const OUT = path.join(
  process.env.KORA_QA_SHOTS || "/tmp/kora-shots",
  process.env.KORA_QA_LABEL || "baseline",
);
const WIDTHS = [
  { width: 375, height: 812 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];
const SETTINGS = [
  "general",
  "providers",
  "engines",
  "swarm",
  "connections",
  "projects",
  "blobs",
  "diagnostics",
  "outside",
];

spec("99-visual", { stack: STACK }, async (t) => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const vp of WIDTHS) {
    const snap = async (page, name) => {
      await page.waitForTimeout(1200);
      await page.addStyleTag({
        content:
          "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
      });
      await page.screenshot({ path: path.join(OUT, `${name}-${vp.width}.png`) });
    };
    t.test(
      `home ${vp.width}`,
      async ({ page, open }) => {
        await open("/");
        await snap(page, "home");
      },
      { viewport: vp },
    );
    t.test(
      `thread ${vp.width}`,
      async ({ page, open, seed }) => {
        const s = seed();
        const fixture = s.threads.find((x) => x.title.startsWith("Fixture: rich"));
        await open(`/kora-local/${fixture.id}`);
        await page.getByText("Summary").first().waitFor({ timeout: 20_000 });
        await snap(page, "thread");
      },
      { viewport: vp },
    );
    t.test(
      `blobs ${vp.width}`,
      async ({ page, open }) => {
        await open("/blobs");
        await snap(page, "blobs");
      },
      { viewport: vp },
    );
    t.test(
      `apps ${vp.width}`,
      async ({ page, open }) => {
        await open("/apps");
        await snap(page, "apps");
      },
      { viewport: vp },
    );
    for (const s of SETTINGS) {
      t.test(
        `settings-${s} ${vp.width}`,
        async ({ page, open }) => {
          await open(`/settings/${s}`);
          await snap(page, `settings-${s}`);
        },
        { viewport: vp },
      );
    }
  }
});
