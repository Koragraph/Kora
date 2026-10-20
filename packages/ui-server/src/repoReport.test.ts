// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- a plain node:test file writing manifests to a temp dir.
// The pure half of the repo code map: buildRepoReport over synthetic graphs (no SQLite), plus the path / manifest helpers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderRepoReportMarkdown } from "@kora/shared/repoReport";

import {
  buildRepoReport,
  classifyPath,
  firstSentence,
  readManifests,
  resolveManifestFile,
  type ReportInput,
  type ReportNode,
  type ReportPair,
} from "./repoReport.ts";
import { louvain } from "./repoReportAreas.ts";

/** A tiny graph builder: files, declarations and the dependencies between them. */
class G {
  readonly files: string[] = [];
  readonly nodes: ReportNode[] = [];
  readonly pairs: ReportPair[] = [];
  private seq = 1;
  private readonly fileNode = new Map<string, number>();
  file(p: string): number {
    this.files.push(p);
    const id = this.seq++;
    this.fileNode.set(p, id);
    this.nodes.push({ id, kind: "FILE", name: p, file: p, line: null, endLine: null });
    return id;
  }
  fn(file: string, name: string, line = 1, kind = "METHOD"): number {
    const id = this.seq++;
    this.nodes.push({ id, kind, name, file, line, endLine: line + 5 });
    return id;
  }
  call(from: number, to: number, over: Partial<ReportPair> = {}): void {
    this.pairs.push({ from, to, resolved: 1, heuristic: 0, calls: 1, imports: 0, ...over });
  }
  guess(from: number, to: number): void {
    this.pairs.push({ from, to, resolved: 0, heuristic: 1, calls: 0, imports: 0 });
  }
  imports(a: string, b: string): void {
    this.pairs.push({
      from: this.fileNode.get(a)!,
      to: this.fileNode.get(b)!,
      resolved: 1,
      heuristic: 0,
      calls: 0,
      imports: 1,
    });
  }
  input(over: Partial<ReportInput> = {}): ReportInput {
    return {
      repo: "demo",
      branch: "main",
      indexedSha: "abcdef1234567890",
      stale: false,
      behindCommits: null,
      generatedAt: "2026-10-15T00:00:00.000Z",
      files: this.files,
      nodes: this.nodes,
      pairs: this.pairs,
      docs: [],
      noteRows: [],
      manifests: [],
      history: [{ file: "x", commits: 1, changesWith: [] }],
      repoOnDisk: true,
      ...over,
    };
  }
}

/**
 * A dense cluster: `n` files in `dir`, three declarations each, every declaration calling the same slot of the next two
 * files, and one shared core function (in file 0) that every file calls. Returns the core function and the declarations.
 */
function cluster(g: G, dir: string, n: number, tag = path.basename(dir)) {
  const fns: number[][] = [];
  const names: string[][] = [];
  for (let i = 0; i < n; i += 1) {
    const f = `${dir}/${tag}_${i}.ts`;
    g.file(f);
    fns.push([0, 1, 2].map((j) => g.fn(f, `${tag}_do_${i}_${j}`, 10 + j * 10)));
    names.push([0, 1, 2].map((j) => `${tag}_do_${i}_${j}`));
  }
  const core = g.fn(`${dir}/${tag}_0.ts`, `${tag}_core`, 100);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      g.call(fns[i]![j]!, fns[(i + 1) % n]![j]!);
      g.call(fns[i]![j]!, fns[(i + 2) % n]![j]!);
    }
    if (i > 0) g.call(fns[i]![0]!, core);
  }
  return { core, fns };
}

const names = (r: ReturnType<typeof buildRepoReport>) => r.areas.map((a) => a.name).sort();

test("areas: three dense clusters with a thin link between them come back as three named areas", () => {
  const g = new G();
  const a = cluster(g, "src/alpha", 8);
  const b = cluster(g, "src/beta", 8);
  const c = cluster(g, "src/gamma", 8);
  g.call(a.fns[0]![0]!, b.fns[1]![0]!);
  g.call(b.fns[0]![0]!, c.fns[1]![0]!);
  const r = buildRepoReport(g.input());
  assert.deepEqual(names(r), ["alpha", "beta", "gamma"]);
  for (const area of r.areas) assert.equal(area.files, 8);
  assert.equal(r.stats.files, 24);
  assert.equal(r.fileAreas["src/alpha/alpha_3.ts"], r.fileAreas["src/alpha/alpha_5.ts"]);
  assert.notEqual(r.fileAreas["src/alpha/alpha_3.ts"], r.fileAreas["src/beta/beta_3.ts"]);
  // The area graph: alpha uses beta, beta uses gamma.
  const alpha = r.areas.find((x) => x.name === "alpha")!;
  assert.deepEqual(
    alpha.uses.map((u) => u.areaId),
    ["beta"],
  );
  assert.deepEqual(
    alpha.usedBy.map((u) => u.areaId),
    [],
  );
  assert.match(alpha.summary, /^8 files, 25 declarations\./);
  assert.ok(alpha.keySymbols.some((k) => k.name === "alpha_core"));
});

test("tests, fixtures, benches, examples, vendored, generated, build output and docs never count as hubs, entry points or area members", () => {
  const g = new G();
  const lib = cluster(g, "src/lib", 6);
  const junk = [
    "tests/lib.test.ts",
    "src/lib/__tests__/deep.ts",
    "src/lib/thing.spec.ts",
    "test_lib.py",
    "fixtures/big.ts",
    "bench/run.ts",
    "examples/demo.ts",
    "node_modules/pkg/index.js",
    "vendor/x/y.go",
    "dist/out.js",
    "src/gen/schema.pb.go",
    "docs/guide.ts",
    "vite.config.ts",
    ".github/scripts/ci.js",
  ];
  const junkFns: number[] = [];
  for (const p of junk) {
    g.file(p);
    const f = g.fn(p, `junk_main_${p.length}`);
    junkFns.push(f);
    // Each hammers the library's core 20 times over (a thousand callers in the junk would make a hub out of anything).
    g.call(f, lib.core);
    g.call(f, lib.fns[0]![0]!);
  }
  // A junk "hub": lots of callers, but all of them tests.
  const helper = g.fn("tests/lib.test.ts", "testHelper_shared", 5);
  for (const f of junkFns) g.call(f, helper);
  const r = buildRepoReport(g.input());
  assert.equal(r.stats.files, 6, "only the six library files are in the report");
  for (const p of Object.keys(r.fileAreas)) assert.match(p, /^src\/lib\/lib_\d\.ts$/);
  for (const h of r.hubs) assert.match(h.file, /^src\/lib\//, `hub ${h.name} lives in ${h.file}`);
  assert.ok(!r.hubs.some((h) => h.name === "testHelper_shared"));
  for (const e of r.entryPoints) assert.match(e.file, /^src\/lib\//);
  assert.equal(
    r.stats.testFiles,
    4,
    "tests/lib.test.ts, __tests__/deep.ts, thing.spec.ts, test_lib.py",
  );
  assert.ok(r.caveats.some((c) => /4 test files/.test(c) && /left out/i.test(c)));
});

test("tests are counted per area: by the edges a test file has into the code, else by its name", () => {
  const g = new G();
  const a = cluster(g, "src/alpha", 5);
  cluster(g, "src/beta", 5);
  g.file("tests/alpha.test.ts");
  const t = g.fn("tests/alpha.test.ts", "alpha_suite");
  g.call(t, a.core);
  g.file("src/beta/beta_2.test.ts"); // no edges, but named after a beta file in the same folder
  const r = buildRepoReport(g.input());
  const byName = new Map(r.areas.map((x) => [x.name, x] as const));
  assert.equal(byName.get("alpha")!.testFiles, 1);
  assert.equal(byName.get("beta")!.testFiles, 1);
  assert.equal(r.stats.testFiles, 2);
});

test("area names are unique even when two areas live in one directory, and ids are unique slugs", () => {
  const g = new G();
  // Two clusters whose files all sit in src/svc: different file-name words, same directory.
  const mk = (word: string) => {
    const files = Array.from({ length: 6 }, (_, i) => `src/svc/${word}_${i}.ts`);
    const fns = files.map((f, i) => {
      g.file(f);
      return [g.fn(f, `${word}A${i}_x`), g.fn(f, `${word}B${i}_x`)];
    });
    for (let i = 0; i < files.length; i += 1)
      for (let j = 0; j < 2; j += 1) {
        g.call(fns[i]![j]!, fns[(i + 1) % 6]![j]!);
        g.call(fns[i]![j]!, fns[(i + 2) % 6]![j]!);
      }
    return fns;
  };
  const a = mk("billing");
  const b = mk("search");
  g.call(a[0]![0]!, b[0]![0]!);
  const r = buildRepoReport(g.input());
  assert.equal(r.areas.length, 2);
  const ns = r.areas.map((x) => x.name);
  assert.equal(new Set(ns).size, 2, `names ${ns.join(", ")} are distinct`);
  assert.equal(new Set(r.areas.map((x) => x.id)).size, 2);
  assert.ok(ns.includes("svc"), "the first keeps the plain directory name");
  assert.ok(
    ns.some((n) => /^svc\/(billing|search)$/.test(n)),
    `the other is told apart by its files' shared word: ${ns.join(", ")}`,
  );
});

test("one input, one report: the order rows arrive in does not change the answer", () => {
  const g = new G();
  const a = cluster(g, "src/alpha", 7);
  const b = cluster(g, "src/beta", 7);
  g.call(a.fns[0]![0]!, b.fns[1]![0]!);
  g.call(b.fns[3]![1]!, a.fns[2]![1]!);
  const base = g.input({
    manifests: [
      { file: "src/alpha/alpha_0.ts", why: "package-bin", name: "demo", detail: "bin demo" },
    ],
  });
  const first = JSON.stringify(buildRepoReport(base));
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const shuffle = <T>(xs: ReadonlyArray<T>): T[] => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  for (let k = 0; k < 3; k += 1) {
    const again = JSON.stringify(
      buildRepoReport({
        ...base,
        files: shuffle(base.files),
        nodes: shuffle(base.nodes),
        pairs: shuffle(base.pairs),
      }),
    );
    assert.equal(again, first);
  }
  assert.equal(
    renderRepoReportMarkdown(buildRepoReport(base)),
    renderRepoReportMarkdown(buildRepoReport(base)),
  );
});

test("caps: 12 areas, 15 hubs, 15 entry points, 8 bridges, 10 notes, 5 cycles, 4-8 questions", () => {
  const g = new G();
  const cl: ReturnType<typeof cluster>[] = [];
  for (let i = 0; i < 20; i += 1) cl.push(cluster(g, `src/mod${String(i).padStart(2, "0")}`, 4));
  // Every module reaches the next three: plenty of cross-area dependencies for bridges.
  for (let i = 0; i < 20; i += 1)
    for (const d of [1, 2, 3]) {
      const to = cl[(i + d) % 20]!;
      for (let j = 0; j < 3; j += 1) g.call(cl[i]!.fns[1]![j]!, to.fns[2]![j]!);
    }
  // 30 files that import each other in a ring of 6 + more rings: cycles.
  for (let r = 0; r < 8; r += 1) for (let k = 0; k < 3; k += 1) g.file(`src/ring${r}/r${k}.ts`);
  for (let r = 0; r < 8; r += 1)
    for (let k = 0; k < 3; k += 1)
      g.imports(`src/ring${r}/r${k}.ts`, `src/ring${r}/r${(k + 1) % 3}.ts`);
  // 30 `main`s and 30 notes.
  const noteRows = [];
  for (let i = 0; i < 30; i += 1) {
    const f = `src/cmd${i}/main.ts`;
    g.file(f);
    g.fn(f, "main", 3);
    noteRows.push({ kind: "RATIONALE", file: f, line: 2, text: `TODO: handle case ${i} properly` });
  }
  const manifests = Array.from({ length: 20 }, (_, i) => ({
    file: `src/cmd${i}/main.ts`,
    why: "package-bin" as const,
    name: `tool${i}`,
    detail: `bin tool${i}`,
  }));
  const r = buildRepoReport(g.input({ noteRows, manifests }));
  assert.ok(r.areas.length <= 12, `areas ${r.areas.length}`);
  assert.ok(r.hubs.length <= 15 && r.hubs.length > 0);
  assert.equal(r.entryPoints.length, 15);
  assert.ok(r.bridges.length <= 8 && r.bridges.length > 0);
  assert.equal(r.notes.length, 10);
  assert.equal(r.cycles.length, 5);
  assert.ok(r.questions.length >= 4 && r.questions.length <= 8, `questions ${r.questions.length}`);
  assert.ok(r.caveats.some((c) => /merged down to 12 areas/.test(c)));
  for (const a of r.areas) {
    assert.ok(
      a.keyFiles.length <= 5 &&
        a.keySymbols.length <= 5 &&
        a.uses.length <= 5 &&
        a.usedBy.length <= 5,
    );
    assert.ok(a.dirs.length <= 4);
  }
  for (const b of r.bridges) assert.ok(b.examples.length <= 3);
  for (const h of r.hotspots) assert.ok(h);
  assert.equal(new Set(r.areas.map((x) => x.name)).size, r.areas.length);
});

test("fileAreas holds at most 5000 files, and the report says when it left some out", () => {
  const g = new G();
  for (let i = 0; i < 5200; i += 1) g.file(`src/p${i % 40}/f${i}.ts`);
  const r = buildRepoReport(g.input());
  assert.equal(r.stats.files, 5200);
  assert.equal(Object.keys(r.fileAreas).length, 5000);
  assert.ok(r.caveats.some((c) => /5000/.test(c)));
});

test("hubs: real dependents, no generic method names, guesses weigh almost nothing and say so", () => {
  const g = new G();
  g.file("src/util/format.ts");
  const real = g.fn("src/util/format.ts", "formatMoney_cents", 4);
  const getter = g.fn("src/util/format.ts", "get", 9); // a generic name: x.get() resolves here by accident
  const guessed = g.fn("src/util/format.ts", "render_all_rows", 20);
  const own = g.fn("src/util/format.ts", "only_used_here_fn", 30);
  g.call(real, own);
  for (let i = 0; i < 6; i += 1) {
    g.file(`src/app/page${i}.ts`);
    g.call(g.fn(`src/app/page${i}.ts`, `renderPage_${i}`), real);
    g.call(g.fn(`src/app/page${i}.ts`, `loadPage_${i}`), getter);
    g.guess(g.fn(`src/app/page${i}.ts`, `savePage_${i}`), guessed);
  }
  const r = buildRepoReport(g.input());
  assert.ok(!r.hubs.some((h) => h.name === "get"), "generic names are never hubs");
  const hub = r.hubs.find((h) => h.name === "formatMoney_cents")!;
  assert.equal(hub.dependents, 6);
  assert.equal(hub.dependentFiles, 6);
  assert.equal(hub.heuristicShare, 0);
  assert.equal(hub.file, "src/util/format.ts");
  assert.equal(hub.line, 4);
  const guess = r.hubs.find((h) => h.name === "render_all_rows")!;
  assert.equal(guess.heuristicShare, 1);
  assert.ok(
    r.hubs.indexOf(hub) < r.hubs.indexOf(guess),
    "a resolved hub outranks a pile of guesses",
  );
  assert.ok(r.caveats.some((x) => /generic method names/.test(x)));
  assert.match(renderRepoReportMarkdown(r), /name-matched/);
  // A declaration only its own file uses is not a hub.
  assert.ok(!r.hubs.some((h) => h.name === "only_used_here_fn"));
});

test("hubs carry the first sentence of their docstring (a RATIONALE row above, or the declaration's own)", () => {
  const g = new G();
  const c = cluster(g, "src/app", 5);
  g.file("src/util/a.ts");
  g.file("src/util/b.py");
  const leading = g.fn("src/util/a.ts", "parse_token_stream", 30);
  const inner = g.fn("src/util/b.py", "load_settings_file", 12);
  for (let i = 0; i < 5; i += 1) {
    g.call(c.fns[i]![0]!, leading);
    g.call(c.fns[i]![1]!, inner);
  }
  const r = buildRepoReport(
    g.input({
      docs: [
        {
          file: "src/util/a.ts",
          line: 27,
          text: "/** Splits the input into tokens. Never throws.\n * @param s the text */",
        },
      ],
      docText: (id) =>
        id === inner ? "Read the settings file. Raises when it is malformed." : null,
    }),
  );
  assert.equal(
    r.hubs.find((h) => h.name === "parse_token_stream")!.doc,
    "Splits the input into tokens.",
  );
  assert.equal(r.hubs.find((h) => h.name === "load_settings_file")!.doc, "Read the settings file.");
});

test("entry points: manifests that exist in the graph, main functions, routes, then roots", () => {
  const g = new G();
  const a = cluster(g, "src/core", 6);
  g.file("bin/cli.js");
  g.file("src/server/routes.ts");
  g.file("scripts/migrate.ts");
  const main = g.fn("scripts/migrate.ts", "main", 7);
  const route = g.fn("src/server/routes.ts", "GET /users", 12, "ENDPOINT");
  void route;
  const boss = g.fn("src/core/core_1.ts", "runEverything_now", 300);
  for (let i = 0; i < 6; i += 1) g.call(boss, a.fns[i]![0]!);
  g.call(main, a.fns[0]![1]!);
  const r = buildRepoReport(
    g.input({
      manifests: [
        { file: "./bin/cli.js", why: "package-bin", name: "demo", detail: "bin demo" },
        { file: "dist/index.js", why: "package-main", name: "demo", detail: "main of demo" }, // built: src/ is what the graph has
        { file: "bin/missing.js", why: "package-bin", name: "ghost", detail: "bin ghost" }, // not in the graph: dropped
      ],
    }),
  );
  const whys = r.entryPoints.map((e) => `${e.why}:${e.name}`);
  assert.deepEqual(whys.slice(0, 3), [
    "package-bin:demo",
    "main-function:main",
    "route:GET /users",
  ]);
  assert.ok(whys.includes("root:runEverything_now"));
  assert.ok(!r.entryPoints.some((e) => e.name === "ghost"));
  const bin = r.entryPoints.find((e) => e.why === "package-bin")!;
  assert.equal(bin.file, "bin/cli.js");
  assert.equal(bin.detail, "bin demo");
  assert.equal(r.entryPoints.find((e) => e.why === "route")!.detail, "GET /users");
  const root = r.entryPoints.find((e) => e.name === "runEverything_now")!;
  assert.equal(root.line, 300);
  assert.ok(root.areaId);
});

test("bridges: the heaviest cross-area dependencies, and a narrow waist when nearly all of it goes through one declaration", () => {
  const g = new G();
  const a = cluster(g, "src/web", 8);
  const b = cluster(g, "src/store", 8);
  // Five web callers funnel through one store function that lives in the middle of the store.
  const gate = g.fn("src/store/store_3.ts", "openTransaction_gate", 5);
  g.call(gate, b.core);
  for (let i = 0; i < 5; i += 1) g.call(a.fns[i]![0]!, gate);
  g.call(a.fns[0]![2]!, b.fns[3]![2]!);
  const r = buildRepoReport(g.input());
  const waist = r.bridges.find((x) => x.why === "single-point");
  assert.ok(waist, JSON.stringify(r.bridges.map((x) => [x.from, x.to, x.why, x.edges])));
  assert.equal(waist.from, "web");
  assert.equal(waist.to, "store");
  assert.equal(waist.examples[0]!.to.name, "openTransaction_gate");
  assert.ok(waist.examples.length <= 3);
  assert.equal(waist.edges, 6);
});

test("import cycles come back as file paths, one shortest cycle per cycle group, shortest first", () => {
  const g = new G();
  for (const f of ["a/x.ts", "a/y.ts", "a/z.ts", "b/p.ts", "b/q.ts", "c/solo.ts"]) g.file(f);
  g.imports("a/x.ts", "a/y.ts");
  g.imports("a/y.ts", "a/z.ts");
  g.imports("a/z.ts", "a/x.ts");
  g.imports("a/x.ts", "a/z.ts"); // a shortcut: the shortest cycle through x is x -> z -> x
  g.imports("b/p.ts", "b/q.ts");
  g.imports("b/q.ts", "b/p.ts");
  g.imports("c/solo.ts", "a/x.ts"); // not on a cycle
  const r = buildRepoReport(g.input());
  assert.deepEqual(r.cycles, [
    ["a/x.ts", "a/z.ts"],
    ["b/p.ts", "b/q.ts"],
  ]);
  assert.match(renderRepoReportMarkdown(r), /`b\/p\.ts` -> `b\/q\.ts` -> `b\/p\.ts`/);
});

test("notes keep only NOTE / WHY / HACK / FIXME / TODO / WARNING markers, from code (not tests), strongest first", () => {
  const g = new G();
  cluster(g, "src/app", 4);
  g.file("tests/x.test.ts");
  g.file("docs/guide.md");
  const owner = g.fn("src/app/app_1.ts", "app_do_1_0", 10);
  void owner;
  const r = buildRepoReport(
    g.input({
      noteRows: [
        {
          kind: "RATIONALE",
          file: "src/app/app_1.ts",
          line: 12,
          text: "NOTE: the cache is keyed by id, not name.",
        },
        {
          kind: "RATIONALE",
          file: "src/app/app_2.ts",
          line: 5,
          text: "WARNING: do not call this from a worker.",
        },
        {
          kind: "RATIONALE",
          file: "src/app/app_2.ts",
          line: 9,
          text: "just a plain comment about notes and todos",
        },
        { kind: "RATIONALE", file: "tests/x.test.ts", line: 2, text: "FIXME: flaky on CI" },
        {
          kind: "DOC",
          file: "docs/guide.md",
          line: 1,
          text: "Intro\nHACK: the installer lies about versions.",
        },
      ],
    }),
  );
  assert.deepEqual(
    r.notes.map((n) => n.tag),
    ["WARNING", "HACK", "NOTE"],
  );
  assert.equal(r.notes[0]!.text, "do not call this from a worker.");
  assert.equal(r.notes[2]!.name, "app_do_1_0", "named by the declaration that holds the comment");
  assert.ok(!r.notes.some((n) => n.file.startsWith("tests/")));
});

test("hotspots come from the history rows, source files only; no history is said, not invented", () => {
  const g = new G();
  cluster(g, "src/app", 4);
  const withHistory = buildRepoReport(
    g.input({
      history: [
        { file: "src/app/app_1.ts", commits: 9, changesWith: ["src/app/app_2.ts", "x", "y", "z"] },
        { file: "package-lock.json", commits: 50, changesWith: [] },
        { file: "src/app/app_2.ts", commits: 12, changesWith: [] },
      ],
    }),
  );
  assert.deepEqual(
    withHistory.hotspots.map((h) => [h.file, h.commits]),
    [
      ["src/app/app_2.ts", 12],
      ["src/app/app_1.ts", 9],
    ],
  );
  assert.equal(withHistory.hotspots[1]!.changesWith.length, 3);
  const without = buildRepoReport(g.input({ history: null }));
  assert.deepEqual(without.hotspots, []);
  assert.ok(without.caveats.some((c) => /No git history/.test(c)));
  const gone = buildRepoReport(g.input({ history: null, repoOnDisk: false }));
  assert.ok(gone.caveats.some((c) => /not on disk/.test(c)));
});

test("stale index: the caveat names how far behind it is", () => {
  const g = new G();
  cluster(g, "src/app", 4);
  const r = buildRepoReport(g.input({ stale: true, behindCommits: 3 }));
  assert.equal(r.stale, true);
  assert.ok(r.caveats.some((c) => /3 commits behind HEAD/.test(c)));
  assert.ok(
    buildRepoReport(g.input({ stale: true })).caveats.some((c) => /HEAD has moved/.test(c)),
  );
});

test("a high share of name-matched call edges is a caveat", () => {
  const g = new G();
  const c = cluster(g, "src/app", 4);
  for (let i = 0; i < 4; i += 1)
    for (let j = 0; j < 3; j += 1)
      g.pairs.push({
        from: c.fns[i]![j]!,
        to: c.core,
        resolved: 0,
        heuristic: 2,
        calls: 0,
        imports: 0,
      });
  const r = buildRepoReport(g.input());
  assert.ok(r.stats.heuristicEdgeShare > 0.2);
  assert.ok(r.caveats.some((x) => /name-matched guesses/.test(x)));
});

test("questions use the quick-answer shapes on names the graph can resolve, plus explore questions across linked areas", () => {
  const g = new G();
  const a = cluster(g, "src/web", 6);
  const b = cluster(g, "src/store", 6);
  for (let i = 0; i < 6; i += 1) g.call(a.fns[i]![0]!, b.core);
  const r = buildRepoReport(g.input());
  const kinds = new Set(r.questions.map((q) => q.kind));
  assert.ok(kinds.has("callers") && kinds.has("impact") && kinds.has("explore"));
  for (const q of r.questions) {
    if (q.kind === "callers") assert.match(q.text, /^Who calls [\w$.]+\?$/);
    if (q.kind === "impact") assert.match(q.text, /^What breaks if I change [\w$.]+\?$/);
    if (q.kind === "where") assert.match(q.text, /^Where is [\w$.]+\?$/);
  }
  assert.equal(r.questions[0]!.target, "store_core");
  assert.ok(r.questions.some((q) => /^How does web use store\?$/.test(q.text)));
});

test("an empty or tiny graph still produces a valid report", () => {
  const empty = buildRepoReport(new G().input({ history: null }));
  assert.deepEqual(empty.areas, []);
  assert.deepEqual(empty.hubs, []);
  assert.equal(empty.stats.files, 0);
  assert.ok(empty.caveats.some((c) => /No source files/.test(c)));
  assert.match(renderRepoReportMarkdown(empty), /^# demo: code map/);
  const g = new G();
  g.file("only.py");
  g.fn("only.py", "lonely_function", 1);
  const one = buildRepoReport(g.input());
  assert.equal(one.areas.length, 1);
  assert.equal(one.areas[0]!.name, "root");
  assert.equal(one.stats.languages[0]!.language, "Python");
});

test("louvain: two cliques joined by one edge are two communities; the partition is the same every time", () => {
  const edges = [];
  for (let i = 0; i < 5; i += 1)
    for (let j = i + 1; j < 5; j += 1)
      edges.push({ a: i, b: j, w: 1 }, { a: 5 + i, b: 5 + j, w: 1 });
  edges.push({ a: 0, b: 5, w: 1 });
  const lab = louvain(10, edges);
  assert.equal(new Set(lab).size, 2);
  assert.equal(lab[0], lab[4]);
  assert.equal(lab[5], lab[9]);
  assert.notEqual(lab[0], lab[5]);
  assert.deepEqual([...louvain(10, edges)], [...lab]);
  assert.deepEqual([...louvain(3, [])], [0, 1, 2], "no edges: every node alone");
});

test("classifyPath: what is source, what is a test, and what is left out", () => {
  const cases: Array<[string, string]> = [
    ["src/app.ts", "source"],
    ["bin/cli.js", "source"],
    ["pkg/server/main.go", "source"],
    ["scripts/build.py", "source"],
    ["src/app.test.ts", "test"],
    ["src/app.spec.js", "test"],
    ["pkg/server/main_test.go", "test"],
    ["tests/test_app.py", "test"],
    ["pkg/test_app.py", "test"],
    ["conftest.py", "test"],
    ["src/__tests__/a.ts", "test"],
    ["app/src/test/java/FooTest.java", "test"],
    ["e2e/login.ts", "test"],
    ["testdata/a.go", "fixture"],
    ["fixtures/a.ts", "fixture"],
    ["bench/a.ts", "bench"],
    ["benchmarks/a.py", "bench"],
    ["examples/a.ts", "example"],
    ["node_modules/x/index.js", "vendored"],
    ["vendor/x/a.go", "vendored"],
    ["third_party/a.cc", "vendored"],
    ["dist/a.js", "build"],
    ["build/a.js", "build"],
    ["target/debug/a.rs", "build"],
    ["a/b/c.min.js", "generated"],
    ["api/x.pb.go", "generated"],
    ["a/types.d.ts", "generated"],
    ["a/schema_generated.ts", "generated"],
    ["docs/a.ts", "doc"],
    ["README.md", "doc"],
    ["vite.config.ts", "tooling"],
    [".github/scripts/a.js", "tooling"],
    [".claude/hooks/a.mjs", "tooling"],
    ["package.json", "other"],
    ["pnpm-lock.yaml", "other"],
    ["schema.sql", "other"],
    ["assets/logo.png", "other"],
  ];
  for (const [file, want] of cases) assert.equal(classifyPath(file), want, file);
});

test("firstSentence: comment markers, doc tags and reST roles are stripped; long text is cut", () => {
  assert.equal(firstSentence("/** Parses the thing. Not the other thing. */"), "Parses the thing.");
  assert.equal(
    firstSentence("/**\n * Builds an index\n * of every file.\n * @param root the root\n */"),
    "Builds an index of every file.",
  );
  assert.equal(
    firstSentence("Use :meth:`run` or :class:`~pkg.App`. Then stop."),
    "Use run or pkg.App.",
  );
  assert.equal(firstSentence("@param x only tags"), null);
  assert.equal(firstSentence(""), null);
  const long = firstSentence(`${"word ".repeat(80)}end`)!;
  assert.ok(long.length <= 160 && long.endsWith("…"));
});

test("resolveManifestFile maps a built path back to the source the graph holds", () => {
  const live = new Set(["bin/cli.js", "src/index.ts", "src/util/a.tsx", "lib/x.py"]);
  assert.equal(resolveManifestFile("./bin/cli.js", live), "bin/cli.js");
  assert.equal(resolveManifestFile("dist/index.js", live), "src/index.ts");
  assert.equal(resolveManifestFile("dist/util/a.js", live), "src/util/a.tsx");
  assert.equal(resolveManifestFile("../etc/passwd", live), null);
  assert.equal(resolveManifestFile("nope.js", live), null);
});

test("readManifests: package.json bin/main/exports (root and workspace folders), pyproject scripts, Cargo bins", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kora-manifests-"));
  try {
    fs.mkdirSync(path.join(dir, "packages", "cli"), { recursive: true });
    fs.mkdirSync(path.join(dir, "py"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "root-pkg",
        workspaces: ["packages/*"],
        bin: { rp: "./bin/rp.js" },
        main: "src/index.js",
        exports: { ".": { import: "./src/esm.js" } },
      }),
    );
    fs.writeFileSync(
      path.join(dir, "packages", "cli", "package.json"),
      JSON.stringify({ name: "@x/cli", bin: "dist/cli.js" }),
    );
    fs.writeFileSync(
      path.join(dir, "py", "pyproject.toml"),
      '[project]\nname = "p"\n\n[project.scripts]\npytool = "pkg.cli:main"\n\n[tool.x]\na = 1\n',
    );
    fs.writeFileSync(
      path.join(dir, "Cargo.toml"),
      '[package]\nname = "crate1"\n\n[[bin]]\nname = "crate-bin"\npath = "src/bin/run.rs"\n',
    );
    fs.writeFileSync(path.join(dir, "broken", "package.json"), "{not json", { flag: "w" });
  } catch {
    /* the broken folder does not exist: that write is expected to fail */
  }
  try {
    const m = readManifests(dir);
    const key = (e: (typeof m)[number]) => `${e.why}:${e.name}:${e.file}`;
    const got = m.map(key);
    assert.ok(got.includes("package-bin:rp:bin/rp.js"), got.join("\n"));
    assert.ok(got.includes("package-main:root-pkg:src/index.js"));
    assert.ok(got.includes("package-main:root-pkg:src/esm.js"));
    assert.ok(got.includes("package-bin:@x/cli:packages/cli/dist/cli.js"));
    assert.ok(got.includes("package-bin:crate-bin:src/bin/run.rs"));
    // pyproject lives in a folder that is not a workspace: only the root is read for it.
    assert.ok(!got.some((x) => x.includes("pytool")));
    fs.writeFileSync(
      path.join(dir, "pyproject.toml"),
      '[project.scripts]\ntool = "pkg.cli:main"\n',
    );
    assert.ok(readManifests(dir).some((e) => e.name === "tool" && e.file === "pkg/cli.py"));
    assert.deepEqual(readManifests(path.join(dir, "does-not-exist")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("timing: 5k files / 50k declarations / 150k dependencies build in well under 5 s", () => {
  const g = new G();
  const FILES = 5000;
  const PER = 10;
  const fnIds: number[][] = [];
  let s = 7;
  const rnd = (n: number) => (s = (s * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let i = 0; i < FILES; i += 1) {
    const f = `src/mod${String(Math.floor(i / 50)).padStart(3, "0")}/file${i}.ts`;
    g.file(f);
    fnIds.push(Array.from({ length: PER }, (_, j) => g.fn(f, `fn_${i}_${j}`, 10 + j * 8)));
  }
  for (let i = 0; i < FILES; i += 1) {
    const mod = Math.floor(i / 50);
    for (let j = 0; j < PER; j += 1)
      for (let k = 0; k < 3; k += 1) {
        // 85% of calls stay in the module, the rest go anywhere.
        const target = rnd(100) < 85 ? mod * 50 + rnd(50) : rnd(FILES);
        if (target !== i) g.call(fnIds[i]![j]!, fnIds[target]![rnd(PER)]!);
      }
  }
  const input = g.input();
  assert.ok(input.nodes.length >= 55_000 && input.pairs.length > 100_000);
  const t0 = performance.now();
  const r = buildRepoReport(input);
  const ms = performance.now() - t0;
  console.log(
    `# buildRepoReport on ${r.stats.files} files / ${r.stats.declarations} declarations / ${r.stats.edges} edges: ${Math.round(ms)} ms, ${r.areas.length} areas`,
  );
  assert.ok(ms < 5000, `${Math.round(ms)} ms`);
  assert.equal(r.stats.files, FILES);
  assert.ok(r.areas.length > 3 && r.areas.length <= 12);
});
