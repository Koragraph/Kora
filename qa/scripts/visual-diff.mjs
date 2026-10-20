// node qa/scripts/visual-diff.mjs <dirA> <dirB>  -> per-screenshot % of pixels that differ (>16/255 on any channel).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
const [a, b] = process.argv.slice(2);
const exe = process.env.KORA_QA_CHROMIUM || undefined;
const browser = await chromium.launch({ headless: true, executablePath: exe });
const page = await browser.newPage();
const rows = [];
for (const f of fs
  .readdirSync(a)
  .filter((x) => x.endsWith(".png"))
  .sort()) {
  const pb = path.join(b, f);
  if (!fs.existsSync(pb)) {
    rows.push([f, "MISSING"]);
    continue;
  }
  const r = await page.evaluate(
    async ([x, y]) => {
      const load = (d) =>
        new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = rej;
          i.src = d;
        });
      const [ia, ib] = await Promise.all([load(x), load(y)]);
      if (ia.width !== ib.width || ia.height !== ib.height)
        return { size: [ia.width, ia.height, ib.width, ib.height] };
      const px = (img) => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, img.width, img.height).data;
      };
      const da = px(ia),
        db = px(ib);
      let n = 0;
      for (let i = 0; i < da.length; i += 4)
        if (
          Math.abs(da[i] - db[i]) > 16 ||
          Math.abs(da[i + 1] - db[i + 1]) > 16 ||
          Math.abs(da[i + 2] - db[i + 2]) > 16
        )
          n++;
      return { pct: (100 * n) / (da.length / 4) };
    },
    [
      "data:image/png;base64," + fs.readFileSync(path.join(a, f)).toString("base64"),
      "data:image/png;base64," + fs.readFileSync(pb).toString("base64"),
    ],
  );
  rows.push([f, r.size ? `SIZE ${r.size.join("x")}` : r.pct.toFixed(2) + "%"]);
}
for (const r of rows) console.log(r[0].padEnd(34), r[1]);
await browser.close();
