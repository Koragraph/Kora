// Terminal-pane stability: thread switching with streaming TUIs, window resizes, and a binary-output flood.
// Needs 3 seeded threads (seed-panes.cjs) and a dev build (the surface exposes canvas.__koraSurface.debugState()).
import path from "node:path";
import { createRequire } from "node:module";
import { spec, QA_ROOT, openDockGroup } from "../lib/harness.mjs";

const require = createRequire(import.meta.url);
const { KoraClient } = require(path.join(QA_ROOT, "../packages/runtime/dist/protocol/client.js"));

const STACK = Number(process.env.KORA_QA_STACK || 3);
const TUI = path.join(QA_ROOT, "e2e/12-panes/fixtures/tui.sh");
const ROW = /^\|(\S+) r(\d\d) f(\d{5}) (\d+)x(\d+)\s*\|$/;

// Null when the grid is a coherent frame drawn for the grid's own size, else why not.
export function verdict(st) {
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

const SIZES = [
  [1440, 900],
  [1000, 700],
  [1300, 820],
  [900, 650],
  [1100, 760],
  [1200, 640],
];

spec("12-panes", { stack: STACK }, async (t) => {
  const prepare = async ({ page, open, seed }) => {
    const s = seed();
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
        const q = document.querySelector("canvas")?.__koraSurface;
        return q ? q.debugState() : null;
      });
    const ping = () =>
      page.evaluate(
        () =>
          new Promise((r) => {
            const t0 = performance.now();
            requestAnimationFrame(() => r(Math.round(performance.now() - t0)));
          }),
      );
    return { s, go, state, ping };
  };

  t.test("thread switching + resizing keeps every streaming pane coherent", async (ctx) => {
    const { page, sleep, expect, stack } = ctx;
    const { go, state } = await prepare(ctx);
    const kc = new KoraClient(stack.env.KORA_SOCKET_PATH);
    await kc.connect();
    const ptyDims = async () =>
      (await kc.call("pane.list", {})).panes.map((p) => `${p.cols}x${p.rows}`).join(",");
    setTimeout(() => process.exit(2), 280000).unref();
    const settle = async (limit = 4000) => {
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
      await sleep(1000);
      await openDockGroup(page, "terminal");
      await sleep(1200);
      await page.locator("canvas").first().click();
      await page.keyboard.type(`${TUI} T${"ABC"[i]} lazy`);
      await page.keyboard.press("Enter");
      const first = await settle(8000);
      expect(first.ms !== null, `thread ${i} never drew its TUI: ${first.why}`);
    }
    const worst = [];
    for (let round = 0; round < 3; round++) {
      for (let k = 0; k < 12; k++) {
        const [w, h] = SIZES[(k * 5 + round) % SIZES.length];
        await page.setViewportSize({ width: w, height: h });
        await go((k + round) % 3);
        await sleep(30 + ((k * 37 + round * 11) % 90));
      }
      for (let i = 0; i < 3; i++) {
        await go(i);
        const r = await settle();
        expect(
          r.ms !== null,
          `round ${round} thread ${i} stayed incoherent: ${r.why} (client grid ${(await state())?.cols}x${(await state())?.rows}, ptys ${await ptyDims()}) rows ${JSON.stringify((await state())?.text.slice(0, 5))}`,
        );
        worst.push(r.ms);
      }
    }
    console.log("settle ms", JSON.stringify(worst));
    expect(Math.max(...worst) < 2500, `slowest settle ${Math.max(...worst)}ms`);
    const f0 = (await state()).frames;
    await sleep(1500);
    expect((await state()).frames >= f0, "frame counter went backwards");
    const longest = await page.evaluate(() => Math.max(0, ...window.__long));
    expect(longest < 3000, `main thread blocked for ${longest}ms during switching`);
  });

  t.test("a 3 MB binary flood neither freezes the page nor kills the pane", async (ctx) => {
    const { page, sleep, expect, open } = ctx;
    const { state, ping } = await prepare(ctx);
    await openDockGroup(page, "terminal");
    await sleep(2500);
    await page.locator("canvas").first().click();
    await page.keyboard.type(
      `python3 -c "import random,sys; sys.stdout.buffer.write(random.Random(7).randbytes(3000000))"; printf '\\033c'; echo DONE-$((1+1))random`,
    );
    await page.keyboard.press("Enter");
    const t0 = Date.now();
    let maxPing = 0,
      done = null;
    while (Date.now() - t0 < 60000) {
      maxPing = Math.max(maxPing, await Promise.race([ping(), sleep(8000).then(() => 8000)]));
      const st = await state();
      if (st && st.text.some((l) => l.includes("DONE-2random"))) {
        done = Date.now() - t0;
        break;
      }
      await sleep(100);
    }
    const longest = await page.evaluate(() => Math.max(0, ...window.__long));
    console.log(`flood done ${done}ms, max frame wait ${maxPing}ms, longest task ${longest}ms`);
    expect(done !== null, "the flood never finished");
    expect(maxPing < 1500, `page unresponsive for ${maxPing}ms while flooding`);
    expect(longest < 1500, `main thread blocked for ${longest}ms by binary output`);
    await page.keyboard.type("printf '\\033c'; echo ALIVE-$((6*7))");
    await page.keyboard.press("Enter");
    const t1 = Date.now();
    let alive = false;
    while (Date.now() - t1 < 6000 && !alive) {
      alive = ((await state())?.text ?? []).some((l) => l.includes("ALIVE-42"));
      await sleep(100);
    }
    expect(alive, "the terminal did not answer after the flood");
  });
});
