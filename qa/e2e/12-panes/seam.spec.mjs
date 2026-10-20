import path from "node:path";
import { spec, QA_ROOT, ROUND, openDockGroup } from "../lib/harness.mjs";
const STACK = Number(process.env.KORA_QA_STACK || 3);
const TUI = path.join(QA_ROOT, "e2e/12-panes/fixtures/tui.sh");

const ROW = /^\|(\S+) r(\d\d) f(\d{5}) (\d+)x(\d+)\s*\|$/;
// Is the visible grid a coherent frame at the grid's own size? Returns null when fine, else why not.
function verdict(st) {
  if (!st) return "no surface";
  if (st.text.length !== st.rows) return `rows ${st.text.length} != ${st.rows}`;
  for (let i = 0; i < st.rows; i++) {
    const m = ROW.exec(st.text[i].padEnd(st.cols));
    if (!m) return `row ${i + 1} garbled: ${JSON.stringify(st.text[i].slice(0, 60))}`;
    if (Number(m[2]) !== i + 1) return `row ${i + 1} holds r${m[2]}`;
    if (Number(m[4]) !== st.cols || Number(m[5]) !== st.rows)
      return `row ${i + 1} drawn for ${m[4]}x${m[5]}, grid is ${st.cols}x${st.rows}`;
    if (st.text[i].length !== st.cols)
      return `row ${i + 1} width ${st.text[i].length} != ${st.cols}`;
  }
  return null;
}

spec("12-panes", { stack: STACK }, async (t) => {
  t.test(
    "thread switches during a live stream never repeat or lose a line",
    async ({ page, open, seed, sleep, expect }) => {
      setTimeout(() => process.exit(2), 280000).unref();
      const s = seed();
      const dir = path.join(QA_ROOT, "runs", ROUND, "12-panes");
      const shot = (n) => page.screenshot({ path: path.join(dir, n + ".png") });
      await page.addInitScript(() => {
        window.__long = [];
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__long.push(Math.round(e.duration));
        }).observe({ entryTypes: ["longtask"] });
      });
      await open(`/kora-local/${s.threads[0].id}`);
      const go = (i) =>
        page.evaluate((id) => {
          history.pushState({}, "", `/kora-local/${id}`);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }, s.threads[i].id);
      const state = () =>
        page.evaluate(() => {
          const c = document.querySelector("canvas");
          const q = c?.__koraSurface;
          if (!q) return null;
          const d = q.debugState();
          return {
            w: c.clientWidth,
            h: c.clientHeight,
            cols: d.cols,
            rows: d.rows,
            frames: d.frames,
            visible: d.visible,
            text: d.text,
          };
        });
      // Poll until the grid is a coherent frame; report how long that took (or why it never did).
      const settle = async (limit = 5000) => {
        const t0 = Date.now();
        let why = "no surface";
        while (Date.now() - t0 < limit) {
          why = verdict(await state());
          if (!why) return { ms: Date.now() - t0 };
          await sleep(40);
        }
        return { ms: null, why };
      };
      for (let i = 0; i < 3; i++) {
        await go(i);
        await sleep(1200);
        await openDockGroup(page, "terminal");
        await sleep(1500);
        await page.locator("canvas").first().click();
        const tag = "ABC"[i];
        await page.keyboard.type(
          `for i in $(seq 1 6000); do echo "L${tag} $i ........................................"; sleep 0.004; done`,
        );
        await page.keyboard.press("Enter");
        await sleep(500);
      }
      await sleep(3000);
      const seams = [];
      const seqCheck = (st) => {
        const nums = st.text
          .map((l) => /^L[ABC] (\d+) \.{40}$/.exec(l))
          .filter(Boolean)
          .map((m) => Number(m[1]));
        const bad = [];
        for (let i = 1; i < nums.length; i++)
          if (nums[i] !== nums[i - 1] + 1) bad.push(`${nums[i - 1]}->${nums[i]}`);
        const junk = st.text.filter(
          (l) => l && !/^L[ABC] \d+ \.{40}$/.test(l) && !/\$|%/.test(l),
        ).length;
        return { n: nums.length, bad, junk };
      };
      for (let k = 0; k < 24; k++) {
        await go(k % 3);
        for (const wait of [30, 120, 400]) {
          await sleep(wait);
          const st = await state();
          if (!st) {
            seams.push({ k, wait, err: "no surface" });
            continue;
          }
          const r = seqCheck(st);
          if (r.bad.length || r.junk) {
            seams.push({ k, wait, ...r });
            await shot(`d-seam${k}-${wait}`);
          }
        }
      }
      console.log("SEAMS " + JSON.stringify(seams));
      expect(
        seams.length === 0,
        `seam damage at ${seams.length} of 72 checks: ${JSON.stringify(seams.slice(0, 3))}`,
      );
      console.log("LONG " + JSON.stringify(await page.evaluate(() => window.__long)));
    },
  );
});
