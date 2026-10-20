// Graph Explorer Overview tab: the repo code map rendered from a fixture report (GET /api/graph/report is mocked, so this
// runs before the backend lands) at narrow and wide widths, the Graph tab coloured by area, and the click routing.
// Screenshots go to $KORA_QA_SHOTS (default <qa>/runs/<round>/21-graph-report).
import fs from "node:fs";
import path from "node:path";
import { spec, QA_ROOT, ROUND } from "../lib/harness.mjs";

const STACK = Number(process.env.KORA_QA_STACK || 4);
const SHOTS = process.env.KORA_QA_SHOTS || path.join(QA_ROOT, "runs", ROUND, "21-graph-report");
fs.mkdirSync(SHOTS, { recursive: true });

const sym = (name, kind, file, line) => ({ name, kind, file, line });
const area = (id, name, files, extra = {}) => ({
  id,
  name,
  dirs: [name],
  files,
  declarations: files * 12,
  testFiles: Math.round(files / 5),
  keyFiles: [
    { file: `${name}/index.ts`, dependents: files },
    { file: `${name}/internal/a/very/deep/module/with/a/long/path/helpers.ts`, dependents: 7 },
  ],
  keySymbols: [],
  uses: [],
  usedBy: [],
  summary: `${files} files, ${files * 12} declarations. Most used: entry (${files} dependents).`,
  ...extra,
});
const REPORT = {
  version: 1,
  repo: "atlas",
  branch: "main",
  indexedSha: "9f3c2a1b7d44e0c8",
  stale: true,
  generatedAt: "2026-10-15T09:30:00.000Z",
  stats: {
    files: 264,
    declarations: 3296,
    edges: 11840,
    testFiles: 71,
    heuristicEdgeShare: 0.18,
    languages: [
      { language: "TypeScript", files: 221 },
      { language: "Python", files: 31 },
    ],
  },
  areas: [
    area("web", "web", 63, { uses: [{ areaId: "server", edges: 27 }] }),
    area("resolution", "services/resolution", 54, {
      uses: [
        { areaId: "store", edges: 63 },
        { areaId: "parsing", edges: 18 },
      ],
      usedBy: [
        { areaId: "cli", edges: 44 },
        { areaId: "server", edges: 36 },
      ],
    }),
    area("store", "graph/store", 41, {
      usedBy: [
        { areaId: "resolution", edges: 63 },
        { areaId: "server", edges: 52 },
        { areaId: "cli", edges: 21 },
      ],
    }),
    area("cli", "cli", 38, {
      uses: [
        { areaId: "resolution", edges: 44 },
        { areaId: "store", edges: 21 },
      ],
    }),
    area("parsing", "parsing", 29, { usedBy: [{ areaId: "resolution", edges: 18 }] }),
    area("server", "server/api", 22, {
      uses: [{ areaId: "store", edges: 52 }],
      usedBy: [{ areaId: "web", edges: 27 }],
    }),
    area("merge", "merge/gate", 17, { uses: [{ areaId: "store", edges: 12 }] }),
  ],
  hubs: [
    {
      ...sym("openStore", "METHOD", "graph/store/db.ts", 21),
      dependents: 58,
      dependentFiles: 33,
      areasReached: 4,
      heuristicShare: 0.04,
      doc: "Open the SQLite store read-only unless a writer asks.",
      areaId: "store",
    },
    {
      ...sym("resolveSymbol", "METHOD", "services/resolution/resolver.ts", 88),
      dependents: 47,
      dependentFiles: 26,
      areasReached: 3,
      heuristicShare: 0.09,
      doc: "Resolve a name to the declaration it refers to in this scope.",
      areaId: "resolution",
    },
    {
      ...sym(
        "ScopeChain",
        "CLASS",
        "services/resolution/internal/scopes/chain/ScopeChainWithAVeryLongNameIndeedForTruncation.ts",
        14,
      ),
      dependents: 29,
      dependentFiles: 12,
      areasReached: 2,
      heuristicShare: 0.62,
      doc: null,
      areaId: "resolution",
    },
  ],
  entryPoints: [
    {
      ...sym("atlas", "FILE", "bin/atlas.js", null),
      why: "package-bin",
      detail: "atlas",
      areaId: "cli",
    },
    {
      ...sym("GET /api/graph", "ENDPOINT", "server/api/routes.ts", 44),
      why: "route",
      detail: "GET /api/graph",
      areaId: "server",
    },
  ],
  bridges: [
    {
      from: "resolution",
      to: "store",
      edges: 63,
      why: "strongest",
      examples: [
        {
          from: sym("resolveSymbol", "METHOD", "services/resolution/resolver.ts", 88),
          to: sym("openStore", "METHOD", "graph/store/db.ts", 21),
        },
      ],
    },
    { from: "merge", to: "store", edges: 12, why: "single-point", examples: [] },
    { from: "web", to: "server", edges: 27, why: "unexpected", examples: [] },
  ],
  hotspots: [
    {
      file: "services/resolution/resolver.ts",
      commits: 142,
      changesWith: ["services/resolution/scope.ts", "graph/store/db.ts"],
    },
    { file: "cli/commands/ingest.ts", commits: 96, changesWith: [] },
  ],
  cycles: [
    [
      "services/resolution/resolver.ts",
      "services/resolution/scope.ts",
      "services/resolution/resolver.ts",
    ],
  ],
  notes: [
    {
      ...sym("resolveSymbol", "METHOD", "services/resolution/resolver.ts", 88),
      tag: "WHY",
      text: "Walks scopes innermost-first; hoisted declarations are matched only after the walk fails.",
    },
  ],
  questions: [
    { text: "Who calls openStore?", kind: "callers", target: "openStore" },
    {
      text: "What breaks if I change graph/store/db.ts?",
      kind: "impact",
      target: "graph/store/db.ts",
    },
    {
      text: "How does services/resolution use graph/store?",
      kind: "explore",
      target: "resolution",
    },
  ],
  fileAreas: {},
  caveats: [
    "The index is 3 commits behind HEAD.",
    "Tests, fixtures, generated and vendored code are counted per area but never shown as hubs or entry points.",
  ],
};
// A synthetic snapshot whose files sit in the report's areas.
const SNAP = (() => {
  const dirs = REPORT.areas.map((a) => [a.id, a.name]);
  const nodes = [];
  const fileAreas = {};
  let id = 0;
  for (const [aid, dir] of dirs)
    for (let f = 0; f < 6; f++) {
      const file = `${dir}/f${f}.ts`;
      fileAreas[file] = aid;
      for (let k = 0; k < 6; k++)
        nodes.push({
          id: id++,
          label: `${dir.split("/").pop()}Fn${f}_${k}`,
          file,
          kind: "METHOD",
          cluster: dir,
          degree: 2 + ((f * 7 + k * 3) % 9),
        });
    }
  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    edges.push({ source: i, target: (i * 7 + 1) % nodes.length, kind: "CALLS" });
    if (i % 3 === 0) edges.push({ source: i, target: (i + 1) % nodes.length, kind: "CALLS" });
  }
  REPORT.fileAreas = fileAreas;
  return {
    repo: "atlas",
    branch: "main",
    nodes,
    edges,
    clusters: [],
    stats: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      shownNodes: nodes.length,
      shownEdges: edges.length,
    },
  };
})();

async function mock(page, { report = REPORT, reportStatus = 200, quick = null } = {}) {
  await page.route(
    (u) => u.pathname === "/api/graph/report",
    (r) =>
      reportStatus === 200
        ? r.fulfill({ json: report })
        : r.fulfill({ status: reportStatus, json: { reason: "no indexed graph" } }),
  );
  await page.route(
    (u) => u.pathname === "/api/graph",
    (r) => r.fulfill({ json: SNAP }),
  );
  if (quick)
    await page.route(
      (u) => u.pathname === "/api/graph/quick-answer",
      (r) => {
        quick.push(r.request().postData());
        return r.fulfill({
          json: {
            answer: {
              text: "Graph answer (no agent turn) — openStore is called by 58 declarations.",
              approxTokens: 40,
            },
          },
        });
      },
    );
}
const openPanel = async (page) => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("kora:graph-explorer-open")));
  await page.locator('[data-slot="graph-explorer"]').waitFor({ timeout: 15_000 });
};
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name) });

spec("21-graph-report", { stack: STACK }, async (t) => {
  t.test("overview at a wide width", async ({ page, open, expect }) => {
    await mock(page);
    await open("/");
    await openPanel(page);
    await page.locator('[data-slot="repo-report"]').waitFor();
    expect.ok(
      (await page.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")) === "true",
    );
    await shot(page, "overview-wide-top.png");
    await page.locator('[data-report-section="hubs"]').scrollIntoViewIfNeeded();
    await shot(page, "overview-wide-hubs.png");
    await page.locator('[data-report-section="questions"]').scrollIntoViewIfNeeded();
    await shot(page, "overview-wide-bottom.png");
  });

  t.test(
    "overview at the panel's narrowest width",
    async ({ page, open, inkCheck, expect }) => {
      await mock(page);
      await open("/");
      await openPanel(page);
      await page.locator('[data-slot="repo-report"]').waitFor();
      await shot(page, "overview-narrow-top.png");
      const overflow = await page.evaluate(() => {
        const el = document.querySelector('[data-slot="repo-report"]');
        return el.scrollWidth - el.clientWidth;
      });
      expect.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
      await page.locator('[data-report-section="hubs"]').scrollIntoViewIfNeeded();
      await shot(page, "overview-narrow-hubs.png");
      await page.locator('[data-report-section="bridges"]').scrollIntoViewIfNeeded();
      await shot(page, "overview-narrow-bridges.png");
      await page.locator('[data-report-section="questions"]').scrollIntoViewIfNeeded();
      await shot(page, "overview-narrow-bottom.png");
      const hits = await inkCheck({ root: '[data-slot="graph-explorer"]' });
      console.log("inkCheck hits:", JSON.stringify(hits.slice(0, 10)));
      expect.equal(hits.length, 0);
    },
    { viewport: { width: 390, height: 844 } },
  );

  t.test("graph tab is coloured by area with a legend", async ({ page, open, expect }) => {
    await mock(page);
    await open("/");
    await openPanel(page);
    await page.getByRole("tab", { name: "Graph" }).click();
    await page.getByLabel("Areas").waitFor();
    await page.waitForTimeout(2500);
    await shot(page, "graph-wide.png");
    await page.getByRole("button", { name: /services\/resolution/ }).click();
    await page.waitForTimeout(300);
    await shot(page, "graph-wide-area-lit.png");
    expect.equal(await page.getByLabel("Areas").locator("li").count(), 7);
  });

  t.test("Show in graph lights an area; area links jump", async ({ page, open, expect }) => {
    await mock(page);
    await open("/");
    await openPanel(page);
    await page.getByRole("button", { name: "Show services/resolution in graph" }).click();
    await page.getByLabel("Areas").waitFor();
    expect.ok(
      (await page.getByRole("tab", { name: "Graph" }).getAttribute("aria-selected")) === "true",
    );
    expect.equal(
      await page.getByRole("button", { name: /services\/resolution/ }).getAttribute("aria-pressed"),
      "true",
    );
  });

  t.test(
    "a sparse report hides its empty sections",
    async ({ page, open, expect }) => {
      const sparse = {
        ...REPORT,
        repo: "scratch",
        stale: false,
        indexedSha: null,
        stats: {
          files: 4,
          declarations: 19,
          edges: 21,
          testFiles: 0,
          heuristicEdgeShare: 0,
          languages: [],
        },
        areas: [area("app", "app", 4)],
        hubs: [],
        entryPoints: [
          {
            ...sym("main", "METHOD", "app/main.py", 3),
            why: "main-function",
            detail: null,
            areaId: "app",
          },
        ],
        bridges: [],
        hotspots: [],
        cycles: [],
        notes: [],
        questions: [],
        caveats: ["No git history in the graph, so what changes most is left out."],
      };
      await mock(page, { report: sparse });
      await open("/");
      await openPanel(page);
      await page.locator('[data-slot="repo-report"]').waitFor();
      for (const id of ["hubs", "bridges", "hotspots", "cycles", "notes", "questions"])
        expect.equal(await page.locator(`[data-report-section="${id}"]`).count(), 0, id);
      expect.equal(await page.locator('[data-report-section="entryPoints"]').count(), 1);
      await shot(page, "overview-sparse.png");
    },
    { viewport: { width: 390, height: 844 } },
  );

  t.test(
    "not-indexed state",
    async ({ page, open }) => {
      await mock(page, { reportStatus: 404 });
      await open("/");
      await openPanel(page);
      await page.getByText("no complete index yet").waitFor();
      await shot(page, "state-not-indexed.png");
    },
    { allowNetwork: [/api\/graph\/report/], allowConsole: [/404/] },
  );

  t.test("questions route without sending an agent turn", async ({ page, open, seed, expect }) => {
    const quick = [];
    await mock(page, { quick });
    await open("/");
    const s = seed();
    const fixture = s.threads.find((x) => x.title.startsWith("Fixture: rich"));
    await page.getByText("tiny-lib").first().click();
    await page.getByText(fixture.title).first().click();
    await page.getByText("Summary").first().waitFor({ timeout: 20_000 });
    await openPanel(page);
    await page.getByRole("button", { name: "Who calls openStore?" }).click();
    await page.waitForTimeout(1500);
    expect.equal(quick.length, 1, "callers question goes to the quick-answer path");
    await page.getByText("called by 58 declarations").first().waitFor({ timeout: 8000 });
    await page.getByRole("button", { name: /How does services\/resolution use/ }).click();
    await page.waitForTimeout(500);
    const composer = await page.locator('[contenteditable="true"]').first().innerText();
    expect.ok(
      /How does services\/resolution use graph\/store\?/.test(composer),
      `composer: ${composer}`,
    );
    expect.equal(quick.length, 1, "explore never touches quick-answer");
    await shot(page, "questions-routed.png");
  });
});
