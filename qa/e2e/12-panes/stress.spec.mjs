import path from "node:path";
import { createRequire } from "node:module";
import { spec, QA_ROOT, ROUND, openDockGroup } from "../lib/harness.mjs";
const require = createRequire(import.meta.url);
const { KoraClient } = require(path.join(QA_ROOT, "../packages/runtime/dist/protocol/client.js"));
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
  t.test("six rounds of thread switching and resizing leave every pane coherent", async ({ page, open, seed, sleep, stack, expect }) => {
    const kc = new KoraClient(stack.env.KORA_SOCKET_PATH);
    await kc.connect();
    const dims = async () =>
      (await kc.call("pane.list", {})).panes.map((p) => `${p.id}:${p.cols}x${p.rows}`).join(" ");
    setTimeout(() => process.exit(2), 280000).unref();
    const s = seed();
    const failures = [];
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
      await page.keyboard.type(
        `seq 1 600 | awk '{printf "\\033[3%dmhistory line %d ................................................................ \\033[0m\\n", $1%7+1, $1}'; ${TUI} T${"ABC"[i]} lazy`,
      );
      await page.keyboard.press("Enter");
      await sleep(1500);
      console.log("SETUP", i, JSON.stringify((await state())?.text.slice(0, 2)));
    }
    const out = { rounds: [] };
    const sizes = [
      [1440, 900],
      [1000, 700],
      [1300, 820],
      [900, 650],
      [1100, 760],
      [1200, 640],
    ];
    for (let round = 0; round < 6; round++) {
      for (let k = 0; k < 20; k++) {
        const [w, h] = sizes[(k * 5 + round) % sizes.length];
        await page.setViewportSize({ width: w, height: h });
        await go((k + round) % 3);
        await sleep(30 + ((k * 37 + round * 11) % 90));
      }
      const res = [];
      for (let i = 0; i < 3; i++) {
        await go(i);
        const r = await settle(4000);
        res.push(r.ms ?? r.why);
        if (r.ms === null) {
          const st = await state();
          failures.push(
            `round ${round} thread ${i}: ${r.why} (client grid ${st?.cols}x${st?.rows}, ptys ${await dims()})`,
          );
          await shot(`h-r${round}-t${i}`);
        }
      }
      out.rounds.push(res);
    }
    out.long = await page.evaluate(() => Math.max(0, ...window.__long));
    console.log("RESULT " + JSON.stringify(out));
    expect(failures.length === 0, failures.join("; "));
  });
});
