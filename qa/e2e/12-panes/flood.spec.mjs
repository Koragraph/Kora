import path from "node:path";
import { spec, QA_ROOT, ROUND, openDockGroup } from "../lib/harness.mjs";
const STACK = Number(process.env.KORA_QA_STACK || 3);
spec("12-panes", { stack: STACK }, async (t) => {
  t.test("big outputs neither freeze the page nor kill the pane", async ({ page, open, seed, sleep, expect }) => {
    setTimeout(() => process.exit(2), 280000).unref();
    const s = seed();
    const dir = path.join(QA_ROOT, "runs", ROUND, "12-panes");
    await page.addInitScript(() => {
      window.__long = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__long.push(Math.round(e.duration));
      }).observe({ entryTypes: ["longtask"] });
    });
    await open(`/kora-local/${s.threads[0].id}`);
    const state = () =>
      page.evaluate(() => {
        const c = document.querySelector("canvas");
        const q = c?.__koraSurface;
        if (!q) return null;
        const d = q.debugState();
        return { frames: d.frames, text: d.text };
      });
    const ping = () =>
      page.evaluate(
        () =>
          new Promise((r) => {
            const t0 = performance.now();
            requestAnimationFrame(() => r(Math.round(performance.now() - t0)));
          }),
      );
    await openDockGroup(page, "terminal");
    await sleep(2500);
    await page.locator("canvas").first().click();
    const cases = [
      ["lines", `yes "$(printf 'x%.0s' $(seq 1 120))" | head -n 200000; echo DONE-lines`],
      ["random", `head -c 3000000 /dev/urandom; printf '\\033c'; echo DONE-random`],
      [
        "ansi",
        `for i in $(seq 1 3000); do printf '\\033[2J\\033[H\\033[31mframe %d\\033[0m\\n' $i; done; echo DONE-ansi`,
      ],
    ];
    const out = [];
    for (const [name, cmd] of cases) {
      await page.evaluate(() => {
        window.__long.length = 0;
      });
      await page.keyboard.type(cmd);
      await page.keyboard.press("Enter");
      const t0 = Date.now();
      let maxPing = 0,
        done = null;
      while (Date.now() - t0 < 60000) {
        const p = await Promise.race([ping(), sleep(8000).then(() => 8000)]);
        maxPing = Math.max(maxPing, p);
        const st = await state();
        if (st && st.text.some((l) => l.includes("DONE-" + name))) {
          done = Date.now() - t0;
          break;
        }
        await sleep(100);
      }
      const long = await page.evaluate(() => window.__long);
      await page.keyboard.type("echo ALIVE-" + name);
      await page.keyboard.press("Enter");
      await sleep(1500);
      const st = await state();
      out.push({
        name,
        doneMs: done,
        maxFramePingMs: maxPing,
        longTasks: long.length,
        maxLong: Math.max(0, ...long),
        alive: !!st?.text.some((l) => l.includes("ALIVE-" + name)),
        frames: st?.frames,
      });
      await page.screenshot({ path: path.join(dir, `g-${name}.png`) });
      await page.keyboard.type("clear");
      await page.keyboard.press("Enter");
      await sleep(500);
    }
    console.log("RESULT " + JSON.stringify(out));
    for (const r of out) {
      expect(r.doneMs !== null, `${r.name}: never finished`);
      expect(r.maxFramePingMs < 1500, `${r.name}: page unresponsive for ${r.maxFramePingMs}ms`);
      expect(r.maxLong < 1500, `${r.name}: main thread blocked for ${r.maxLong}ms`);
      expect(r.alive, `${r.name}: the terminal did not answer afterwards`);
    }
  });
});
