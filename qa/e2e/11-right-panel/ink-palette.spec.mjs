import { spec, threadIdByTitle, openDockGroup } from "../lib/harness.mjs";

const HOST = "kora-local";
const THREAD_ONE = threadIdByTitle(3, "[a11] chat one"); // [a11] chat one

async function openThread(ctx, threadId) {
  await ctx.open(`/${HOST}/${threadId}`);
  await ctx.page.waitForFunction(() => !!document.querySelector('[contenteditable="true"]'), null, {
    timeout: 20_000,
  });
  await ctx.sleep(500);
}

spec("11-right-panel", { stack: 3 }, async (t) => {
  t.test(
    "the --info design token used by status dots and badges is an Ink grey, not blue",
    async (ctx) => {
      const { page, step, inkCheck } = ctx;
      await openThread(ctx, THREAD_ONE);

      // (Regression guard: --info once fell through to `var(--color-blue-500)`.) Inject the info
      // classes status dots and badges use so the check measures the browser's real computed colour.
      step("inject bg-info / text-info-foreground / border-info probes");
      await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.id = "qa-info-token-probe";
        probe.innerHTML = `
          <span class="bg-info block h-4 w-4"></span>
          <span class="text-info-foreground">Working</span>
          <span class="border-info/40 border block h-4 w-4"></span>
        `;
        document.body.appendChild(probe);
      });

      const hits = await inkCheck({ root: "#qa-info-token-probe" });
      await page.evaluate(() => document.getElementById("qa-info-token-probe")?.remove());

      const cold = hits.filter((h) => h.kind === "cold");
      ctx.expect.deepEqual(cold, [], `--info must be an Ink grey, found ${JSON.stringify(cold)}`);
    },
    {
      control: "Ink palette — --info token (status dots / badges)",
      severity: "visual",
      expected:
        "every colour in the right panel is a neutral Ink grey or an allowed semantic red/amber/green",
    },
  );

  t.test(
    "the file tree's selected/focused row is ringed in an Ink colour, not blue",
    async (ctx) => {
      const { page, context, step } = ctx;
      await openThread(ctx, THREAD_ONE);
      await openDockGroup(page, "files");

      step("focus the src row (a directory) in the file tree");
      const srcRow = page.getByRole("treeitem", { name: "src" });
      await srcRow.waitFor({ state: "visible" });
      await srcRow.click();
      await ctx.sleep(300);

      // The file tree is the third-party @pierre/trees web component, rendered
      // inside an open shadow root. getComputedStyle on the row itself reports
      // outline/box-shadow as "none" (the ring is likely drawn by the
      // component's internal canvas/paint layer, not a CSSOM-visible
      // property), so the only reliable way to verify its colour is to sample
      // the actual rendered pixels at the row's top edge.
      const rowRect = await page.evaluate(() => {
        const host = [...document.querySelectorAll("*")].find((e) => e.shadowRoot);
        const row = host.shadowRoot.querySelector('[aria-label="src"]');
        const r = row.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });

      const png = await page.screenshot();
      const samplePage = await context.newPage();
      await samplePage.setContent(
        `<img id="i" src="data:image/png;base64,${png.toString("base64")}" />`,
      );
      await samplePage.waitForFunction(() => document.getElementById("i").complete);
      const pixels = await samplePage.evaluate(({ x, y, w, h }) => {
        const img = document.getElementById("i");
        const cv = document.createElement("canvas");
        cv.width = img.naturalWidth;
        cv.height = img.naturalHeight;
        const cx = cv.getContext("2d");
        cx.drawImage(img, 0, 0);
        const pts = [
          ["top-left", x + 2, y + 1],
          ["top-mid", x + w / 2, y + 1],
          ["left-mid", x + 1, y + h / 2],
          ["row-center", x + w / 2, y + h / 2],
        ];
        return Object.fromEntries(
          pts.map(([label, px, py]) => [
            label,
            [...cx.getImageData(Math.round(px), Math.round(py), 1, 1).data],
          ]),
        );
      }, rowRect);
      await samplePage.close();

      step(`sampled ring pixels: ${JSON.stringify(pixels)}`);
      const isBlue = ([r, g, b]) => b > r + 30 && b > g + 30 && b > 120;
      const blueEdge = Object.entries(pixels).find(([, rgba]) => isBlue(rgba));

      ctx.expect.ok(
        !blueEdge,
        `the focused tree row is ringed in blue (${blueEdge?.[0]}: rgba(${blueEdge?.[1]?.join(",")}))`,
      );
    },
    {
      control: "File browser tree row focus/selection ring",
      severity: "visual",
      expected: "Stone-grey focus ring, not blue",
    },
  );
});
