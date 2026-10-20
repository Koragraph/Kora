// @effect-diagnostics globalDate:off -- plain timestamps for the cache and the report header, produced outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- plain Node: this module runs in the graph reader child process.
/**
 * The repo "code map" (contract: docs/graph/REPO-REPORT.md, types: packages/shared/src/repoReport.ts): areas, hubs, entry
 * points, bridges, hotspots, cycles, notes and questions for one indexed repo, built from the code graph alone.
 *
 * Two halves, so the logic is testable without SQLite:
 *   - `buildRepoReport(input)`: PURE, over plain data (the files, the live nodes, the dependency pairs between them, the
 *     docstrings, the manifests read from disk, the git history rows). Deterministic: one input, one report.
 *   - `buildRepoReportForCwd(cwd)`: the loader. Read-only SQL over the shared store (same rules as graph.ts: the same
 *     repo resolver as the chip, an index that died part-way is "no graph", slow-statement logging, store maintenance =
 *     busy), a cache per branch and index generation, then the builder. It runs in the graph reader child
 *     (graphReadWorker.ts op `report`), never on the daemon's main thread.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  REPO_REPORT_VERSION,
  type RepoArea,
  type RepoAreaLink,
  type RepoBridge,
  type RepoEntryPoint,
  type RepoHotspot,
  type RepoHub,
  type RepoNote,
  type RepoQuestion,
  type RepoReport,
  type RepoSymbolRef,
} from "@kora/shared/repoReport";

import {
  indexDiedPartWay,
  openGraphStore,
  readHeadSha,
  reportSafeRead,
  resolveRepoForCwd,
  type GraphDb,
} from "./graph.ts";
import { louvain, type WeightedEdge } from "./repoReportAreas.ts";

// ---------------------------------------------------------------- caps (the contract's numbers)

export const MAX_AREAS = 12;
const MAX_HUBS = 15;
const MAX_ENTRY_POINTS = 15;
const MAX_BRIDGES = 8;
const MAX_HOTSPOTS = 10;
const MAX_CYCLES = 5;
const MAX_NOTES = 10;
const MAX_FILE_AREAS = 5000;
const MIN_AREA_FILES = 3;

// ---------------------------------------------------------------- input (plain data)

/** A live node of the branch: a declaration, a FILE, an ENDPOINT or a TEST. */
export interface ReportNode {
  readonly id: number;
  readonly kind: string;
  readonly name: string;
  /** Repo-relative path ("" when the node has no file). */
  readonly file: string;
  readonly line: number | null;
  readonly endLine: number | null;
}

/**
 * All dependency edges from one node to another, folded: `resolved` edges of any resolved type (CALLS, IMPORTS, EXTENDS,
 * IMPLEMENTS, OVERRIDES, REFERENCES, TESTS), `heuristic` name-matched HEURISTIC_CALLS, and how many of the resolved ones
 * are CALLS / IMPORTS (for the call-edge share and the import cycles).
 */
export interface ReportPair {
  readonly from: number;
  readonly to: number;
  readonly resolved: number;
  readonly heuristic: number;
  readonly calls: number;
  readonly imports: number;
}

export interface ReportDoc {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface ReportNoteRow {
  readonly kind: string;
  readonly file: string;
  readonly line: number | null;
  readonly text: string;
}

export interface ReportManifestEntry {
  readonly file: string;
  readonly why: "package-bin" | "package-main";
  readonly name: string;
  readonly detail: string | null;
}

export interface ReportHistoryRow {
  readonly file: string;
  readonly commits: number;
  readonly changesWith: ReadonlyArray<string>;
}

export interface ReportInput {
  readonly repo: string;
  readonly branch: string;
  readonly indexedSha: string | null;
  readonly stale: boolean;
  /** Commits between the index and HEAD, when known. */
  readonly behindCommits: number | null;
  readonly generatedAt: string;
  /** Every live file path of the branch (before any exclusion). */
  readonly files: ReadonlyArray<string>;
  readonly nodes: ReadonlyArray<ReportNode>;
  readonly pairs: ReadonlyArray<ReportPair>;
  readonly docs: ReadonlyArray<ReportDoc>;
  /** A declaration's own docstring (Python / Kotlin keep it on the declaration), fetched only for the few that are shown. */
  readonly docText?: (nodeId: number) => string | null;
  readonly noteRows: ReadonlyArray<ReportNoteRow>;
  readonly manifests: ReadonlyArray<ReportManifestEntry>;
  /** Git history of the checkout; null = none available. */
  readonly history: ReadonlyArray<ReportHistoryRow> | null;
  /** The repo folder could be read on disk (manifests, history). */
  readonly repoOnDisk: boolean;
}

// ---------------------------------------------------------------- what counts

export type PathClass =
  | "source"
  | "test"
  | "fixture"
  | "bench"
  | "example"
  | "vendored"
  | "generated"
  | "build"
  | "doc"
  | "tooling"
  | "other";

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  vue: "Vue",
  svelte: "Svelte",
  py: "Python",
  pyi: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  swift: "Swift",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  hpp: "C++",
  scala: "Scala",
  dart: "Dart",
  lua: "Lua",
  ex: "Elixir",
  exs: "Elixir",
  m: "Objective-C",
  zig: "Zig",
};

const SEG_TEST = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "__mocks__",
  "e2e",
  "testing",
  "integration-tests",
]);
const SEG_FIXTURE = new Set([
  "fixtures",
  "fixture",
  "__fixtures__",
  "testdata",
  "test-data",
  "mocks",
]);
const SEG_BENCH = new Set(["bench", "benches", "benchmark", "benchmarks"]);
const SEG_EXAMPLE = new Set([
  "example",
  "examples",
  "demo",
  "demos",
  "sample",
  "samples",
  "playground",
]);
const SEG_VENDORED = new Set([
  "node_modules",
  "vendor",
  "vendored",
  "third_party",
  "third-party",
  "thirdparty",
  "bower_components",
  "site-packages",
  "venv",
  "pods",
]);
const SEG_GENERATED = new Set(["generated", "__generated__"]);
const SEG_BUILD = new Set([
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "__pycache__",
  "storybook-static",
]);
const SEG_DOC = new Set(["docs", "doc", "documentation", "docs_src"]);

const extOf = (file: string): string => {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
};

/** What a repo-relative path is for. Only "source" files are drawn into areas, hubs and entry points. */
export function classifyPath(file: string): PathClass {
  const parts = file.split("/").filter(Boolean);
  const base = parts[parts.length - 1] ?? "";
  const dirs = parts.slice(0, -1).map((s) => s.toLowerCase());
  const lower = base.toLowerCase();
  for (const d of dirs) {
    if (SEG_VENDORED.has(d)) return "vendored";
    if (SEG_BUILD.has(d)) return "build";
    if (SEG_GENERATED.has(d)) return "generated";
  }
  for (const d of dirs) if (d.startsWith(".")) return "tooling";
  for (const d of dirs) {
    if (SEG_TEST.has(d)) return "test";
    if (SEG_FIXTURE.has(d)) return "fixture";
    if (SEG_BENCH.has(d)) return "bench";
    if (SEG_EXAMPLE.has(d)) return "example";
    if (SEG_DOC.has(d)) return "doc";
  }
  const ext = extOf(file);
  if (ext === "md" || ext === "mdx" || ext === "rst" || ext === "txt") return "doc";
  if (
    /\.(test|spec)\.[a-z0-9]+$/.test(lower) ||
    /_(test|spec)\.[a-z0-9]+$/.test(lower) ||
    /^test_.+\.py$/.test(lower) ||
    lower === "conftest.py" ||
    /(Test|Tests|IT)\.(java|kt|scala|cs)$/.test(base) ||
    /\.stories\.[a-z0-9]+$/.test(lower)
  )
    return "test";
  if (
    /\.min\.(js|css)$/.test(lower) ||
    /\.d\.(ts|mts|cts)$/.test(lower) ||
    lower.endsWith(".pb.go") ||
    /_pb2(_grpc)?\.pyi?$/.test(lower) ||
    /\.(generated|gen)\.[a-z0-9]+$/.test(lower) ||
    /_generated\.[a-z0-9]+$/.test(lower) ||
    lower.endsWith(".g.dart")
  )
    return "generated";
  if (/\.config\.(js|cjs|mjs|ts|cts|mts)$/.test(lower) || /^\.?[a-z]+rc\.(c|m)?js$/.test(lower))
    return "tooling";
  return LANGUAGES[ext] ? "source" : "other";
}

const DECL_KINDS = new Set([
  "METHOD",
  "CLASS",
  "INTERFACE",
  "TYPE",
  "CONSTANT",
  "FIELD",
  "FUNCTION",
  "STRUCT",
  "ENUM",
  "TRAIT",
  "MODULE",
]);
/** Declarations that can be a hub: members/fields are reached through their owner. */
const HUB_KINDS = new Set(DECL_KINDS);
HUB_KINDS.delete("FIELD");

/**
 * Method names the standard library and every framework share (`get`, `copy`, `open`, ...). A call `x.get(...)` on a value
 * of unknown type resolves to the repo's only `get`, so such a "hub" is the resolver's guess, not what the code depends on:
 * they are never ranked (the caveat says so). Dunder methods and constructors are structure, not dependencies.
 */
const GENERIC_NAMES = new Set(
  (
    "get set setdefault pop popitem copy deepcopy items keys values update add append extend insert remove discard clear " +
    "push shift unshift splice slice join split strip replace find index count sort reverse map filter reduce forEach then catch " +
    "finally open close read write flush seek dump dumps load loads format encode decode toString valueOf has delete send call " +
    "apply bind next iter len str int list dict init new constructor"
  ).split(" "),
);
const isGenericName = (name: string): boolean => GENERIC_NAMES.has(name) || /^__\w+__$/.test(name);

const dirOf = (file: string): string => {
  const i = file.lastIndexOf("/");
  return i < 0 ? "" : file.slice(0, i);
};
const baseOf = (file: string): string => file.slice(file.lastIndexOf("/") + 1);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- the builder

/** A name worth a "who calls / where is / what breaks" shaped question: the composer's own rule (graph/quick-answer.ts). */
function isCodeName(n: string): boolean {
  if (!n || n.length < 4 || n.length > 80) return false;
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(n)) return false;
  return (
    /[a-z][A-Z]/.test(n) ||
    n.includes("_") ||
    n.includes(".") ||
    /^[A-Z][a-z]+[A-Za-z0-9]*[A-Z]/.test(n)
  );
}

/** The first sentence of a docstring, without comment markers or doc-tags; null when nothing readable is left. */
export function firstSentence(raw: string, max = 160): string | null {
  let t = raw
    .replace(/^\s*(\/\*\*?|\/\/\/?|#+|"""|''')\s*/, "")
    .replace(/(\*\/|"""|''')\s*$/, "")
    .replace(/^\s*\*\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  t = t
    .replace(/:[a-z]+:`~?([^`]*)`/g, "$1") // reST roles: :meth:`command` -> command
    .replace(/``([^`]*)``/g, "$1")
    .replace(/\.\. [a-z]+::.*$/, "")
    .trim();
  const tag = t.search(/\s@\w+/);
  if (tag >= 0) t = t.slice(0, tag).trim();
  if (!t || t.startsWith("@")) return null;
  const end = /[.!?](\s|$)/.exec(t);
  if (end) t = t.slice(0, end.index + 1);
  if (t.length > max) t = `${t.slice(0, max - 1).trimEnd()}…`;
  return t.length >= 3 ? t : null;
}

interface FileRec {
  readonly path: string;
  readonly dir: string;
  readonly language: string | null;
}

/** Union-find free merge helper over the area groups: link weights between groups, kept symmetric. */
class GroupGraph {
  readonly members = new Map<number, number[]>();
  readonly links = new Map<number, Map<number, number>>();
  private next = 0;

  add(files: number[]): number {
    const id = this.next++;
    this.members.set(id, files);
    this.links.set(id, new Map());
    return id;
  }
  link(a: number, b: number, w: number): void {
    if (a === b) return;
    this.links.get(a)!.set(b, (this.links.get(a)!.get(b) ?? 0) + w);
    this.links.get(b)!.set(a, (this.links.get(b)!.get(a) ?? 0) + w);
  }
  merge(from: number, into: number): void {
    for (const f of this.members.get(from)!) this.members.get(into)!.push(f);
    for (const [c, w] of this.links.get(from)!) {
      this.links.get(c)!.delete(from);
      if (c === into) continue;
      this.link(into, c, w);
    }
    this.members.delete(from);
    this.links.delete(from);
  }
}

export function buildRepoReport(input: ReportInput): RepoReport {
  // ---- files: classify, keep the source ones, index them in path order (determinism)
  const classCount = new Map<PathClass, number>();
  const included: FileRec[] = [];
  const testFilePaths: string[] = [];
  const liveFiles = new Set(input.files);
  for (const p of [...liveFiles].sort(cmp)) {
    const cls = classifyPath(p);
    classCount.set(cls, (classCount.get(cls) ?? 0) + 1);
    const ext = extOf(p);
    if (cls === "source")
      included.push({ path: p, dir: dirOf(p), language: LANGUAGES[ext] ?? null });
    else if (cls === "test" && LANGUAGES[ext]) testFilePaths.push(p);
  }
  const F = included.length;
  const fileIndex = new Map(included.map((f, i) => [f.path, i] as const));
  const testFileSet = new Set(testFilePaths);

  // ---- nodes: the ones that live in an included file (declarations, FILE, ENDPOINT) and the test ones
  const nodeById = new Map<number, ReportNode>();
  const nodeFile = new Map<number, number>(); // node id -> included file index
  const declsPerFile = new Int32Array(F);
  let declarations = 0;
  for (const n of input.nodes) {
    const fi = fileIndex.get(n.file);
    if (fi === undefined) {
      if (testFileSet.has(n.file)) nodeById.set(n.id, n);
      continue;
    }
    nodeById.set(n.id, n);
    nodeFile.set(n.id, fi);
    if (DECL_KINDS.has(n.kind)) {
      declarations += 1;
      declsPerFile[fi]! += 1;
    }
  }

  // ---- pass 1 over the dependency pairs: per-declaration dependents, the file graph
  interface Dep {
    total: number; // distinct dependent declarations
    resolved: number; // of those, resting on at least one resolved edge
    files: Set<number>; // included files they live in
  }
  const deps = new Map<number, Dep>();
  const outgoing = new Map<number, number>(); // distinct targets per source declaration
  const hasIncoming = new Set<number>();
  const fileDir = new Map<number, number>(); // fa*F+fb -> declaration pairs from fa into fb
  const fileDirWeight = new Map<number, number>(); // fa*F+fb -> weight (resolved 1, name-matched 0.5)
  const importAdj = new Map<number, Set<number>>(); // file import graph (FILE -> FILE IMPORTS)
  const testVotes = new Map<string, Map<number, number>>(); // test file -> included file -> edges
  let skippedGeneric = 0;
  let edgeCount = 0;
  let callEdges = 0;
  let heurEdges = 0;
  for (const p of input.pairs) {
    const a = nodeById.get(p.from);
    const b = nodeById.get(p.to);
    if (!a || !b || p.from === p.to) continue;
    const fa = nodeFile.get(p.from);
    const fb = nodeFile.get(p.to);
    if (fa === undefined) {
      // A test file reaching into the code: remembered per test file, to say which area it exercises.
      if (fb !== undefined && testFileSet.has(a.file)) {
        const votes = testVotes.get(a.file) ?? new Map<number, number>();
        votes.set(fb, (votes.get(fb) ?? 0) + 1);
        testVotes.set(a.file, votes);
      }
      continue;
    }
    if (fb === undefined) continue;
    // `x.get(...)` on a value of unknown type resolved to the repo's one `get`: a guess about the standard library, not a
    // dependency. Imports and inheritance to such a name are real and stay.
    if (p.imports === 0 && DECL_KINDS.has(b.kind) && isGenericName(b.name)) {
      skippedGeneric += 1;
      continue;
    }
    edgeCount += 1;
    callEdges += p.calls + p.heuristic;
    heurEdges += p.heuristic;
    const resolved = p.resolved > 0;
    if (fa !== fb) {
      const key = fa * F + fb;
      fileDir.set(key, (fileDir.get(key) ?? 0) + 1);
      fileDirWeight.set(key, (fileDirWeight.get(key) ?? 0) + (resolved ? 1 : 0.5));
      if (a.kind === "FILE" && b.kind === "FILE" && p.imports > 0) {
        const set = importAdj.get(fa) ?? new Set<number>();
        set.add(fb);
        importAdj.set(fa, set);
      }
    }
    if (a.kind !== "FILE" && DECL_KINDS.has(a.kind)) {
      outgoing.set(p.from, (outgoing.get(p.from) ?? 0) + 1);
    }
    if (DECL_KINDS.has(b.kind)) {
      hasIncoming.add(p.to);
      if (DECL_KINDS.has(a.kind)) {
        const d = deps.get(p.to) ?? { total: 0, resolved: 0, files: new Set<number>() };
        d.total += 1;
        if (resolved) d.resolved += 1;
        d.files.add(fa);
        deps.set(p.to, d);
      }
    }
  }

  // ---- areas: communities of the file graph
  // File-level dependents (distinct other files that depend on a file).
  const fileDependents = new Int32Array(F);
  for (const key of fileDir.keys()) fileDependents[key % F]! += 1;
  // Undirected weights for the community search. An edge into a file that half the repo depends on (a db wrapper, a logger)
  // says little about who belongs together, and left at full weight it glues every area to it: damp it by how widely its
  // target is used, like an inverse document frequency.
  const undirected = new Map<number, number>(); // min*F+max
  for (const [key, w] of fileDirWeight) {
    const a = Math.floor(key / F);
    const b = key % F;
    const u = a < b ? a * F + b : b * F + a;
    undirected.set(u, (undirected.get(u) ?? 0) + w / Math.log(2 + fileDependents[b]!));
  }
  const edges: WeightedEdge[] = [];
  const degree = new Int32Array(F);
  for (const [key, w] of [...undirected].sort((x, y) => x[0] - y[0])) {
    const a = Math.floor(key / F);
    const b = key % F;
    edges.push({ a, b, w });
    degree[a]! += 1;
    degree[b]! += 1;
  }
  const areaOfFile = new Int32Array(F).fill(-1);
  const areaGroups = detectAreas(included, edges, degree);
  const rawAreaCount = areaGroups.rawCount;
  const areaFiles: number[][] = areaGroups.groups;
  for (let a = 0; a < areaFiles.length; a += 1) for (const f of areaFiles[a]!) areaOfFile[f] = a;
  const areaNames = nameAreas(included, areaFiles, fileDependents);

  // ---- per-declaration importance
  interface Metric {
    readonly node: ReportNode;
    readonly score: number;
    readonly dependents: number;
    readonly dependentFiles: number;
    readonly crossFile: number;
    readonly heuristicShare: number;
  }
  const metrics: Metric[] = [];
  const nameCount = new Map<string, number>();
  for (const n of nodeById.values()) {
    if (nodeFile.has(n.id) && HUB_KINDS.has(n.kind))
      nameCount.set(n.name, (nameCount.get(n.name) ?? 0) + 1);
  }
  for (const [id, d] of deps) {
    const node = nodeById.get(id)!;
    if (!HUB_KINDS.has(node.kind)) continue;
    if (isGenericName(node.name)) continue;
    const own = nodeFile.get(id)!;
    const crossFiles = [...d.files].filter((f) => f !== own).length;
    if (crossFiles === 0) continue; // only used inside its own file: not something the rest of the code depends on
    const heurOnly = d.total - d.resolved;
    metrics.push({
      node,
      // Name-matched edges are guesses: a tenth each (a bare "query" or "get" must not outrank a resolved hub).
      score: d.resolved + 0.1 * heurOnly,
      dependents: d.total,
      dependentFiles: d.files.size,
      crossFile: crossFiles,
      heuristicShare: d.total === 0 ? 0 : heurOnly / d.total,
    });
  }
  const better = (x: Metric, y: Metric): number =>
    y.score - x.score ||
    y.crossFile - x.crossFile ||
    y.dependents - x.dependents ||
    cmp(x.node.name, y.node.name) ||
    cmp(x.node.file, y.node.file) ||
    (x.node.line ?? 0) - (y.node.line ?? 0);
  metrics.sort(better);

  // ---- docstrings: found on demand for the few declarations that are shown
  const docsByFile = new Map<string, ReportDoc[]>();
  for (const d of input.docs) {
    const list = docsByFile.get(d.file);
    if (list) list.push(d);
    else docsByFile.set(d.file, [d]);
  }
  for (const list of docsByFile.values()) list.sort((x, y) => x.line - y.line);
  const declStarts = new Map<string, number[]>(); // file -> sorted declaration start lines (only for files asked about)
  const startsIn = (file: string): number[] => {
    let s = declStarts.get(file);
    if (!s) {
      s = [];
      for (const n of nodeById.values())
        if (n.file === file && DECL_KINDS.has(n.kind) && n.line) s.push(n.line);
      s.sort((x, y) => x - y);
      declStarts.set(file, s);
    }
    return s;
  };
  const docOf = (n: ReportNode): string | null => {
    const own = input.docText?.(n.id);
    if (own) {
      const sentence = firstSentence(own);
      if (sentence) return sentence;
    }
    const list = docsByFile.get(n.file);
    if (!list || !n.line) return null;
    const starts = startsIn(n.file);
    const end = n.endLine ?? n.line;
    // A docstring inside the body (Python): first one in the declaration, before any nested declaration starts.
    const nextStart = starts.find((s) => s > n.line!) ?? Infinity;
    const inside = list.find((d) => d.line >= n.line! && d.line <= end && d.line < nextStart);
    if (inside) return firstSentence(inside.text);
    // A leading comment (JS/TS/Go/Rust): the nearest one above, with no other declaration between.
    let lead: ReportDoc | undefined;
    for (const d of list) if (d.line < n.line!) lead = d;
    if (lead && n.line - lead.line <= 40 && !starts.some((s) => s > lead!.line && s < n.line!))
      return firstSentence(lead.text);
    return null;
  };

  // ---- entry points (areas are known now)
  const areaIdOf = (file: string): string | null => {
    const fi = fileIndex.get(file);
    return fi === undefined || areaOfFile[fi]! < 0 ? null : areaNames[areaOfFile[fi]!]!.id;
  };
  const entryPoints = buildEntryPoints();

  function buildEntryPoints(): RepoEntryPoint[] {
    const pkg: RepoEntryPoint[] = [];
    const seen = new Set<string>();
    for (const m of input.manifests) {
      const file = resolveManifestFile(m.file, liveFiles);
      if (!file || !fileIndex.has(file) || seen.has(`${file}|${m.why}`)) continue;
      seen.add(`${file}|${m.why}`);
      pkg.push({
        name: m.name,
        kind: "FILE",
        file,
        line: null,
        why: m.why,
        detail: m.detail,
        areaId: areaIdOf(file),
      });
    }
    const mains: RepoEntryPoint[] = [];
    const mainFiles = new Set<string>();
    const candidates = [...nodeById.values()]
      .filter(
        (n) =>
          nodeFile.has(n.id) && (n.kind === "METHOD" || n.kind === "FUNCTION") && n.name === "main",
      )
      .sort(
        (a, b) =>
          a.file.split("/").length - b.file.split("/").length ||
          cmp(a.file, b.file) ||
          (a.line ?? 0) - (b.line ?? 0),
      );
    for (const n of candidates) {
      if (mainFiles.has(n.file)) continue;
      mainFiles.add(n.file);
      mains.push({
        name: n.name,
        kind: n.kind,
        file: n.file,
        line: n.line,
        why: "main-function",
        detail: null,
        areaId: areaIdOf(n.file),
      });
    }
    for (const f of included) {
      const b = baseOf(f.path);
      if (
        !mainFiles.has(f.path) &&
        (b === "__main__.py" ||
          b === "main.go" ||
          b === "main.rs" ||
          b === "Main.java" ||
          b === "manage.py")
      ) {
        mainFiles.add(f.path);
        mains.push({
          name: b,
          kind: "FILE",
          file: f.path,
          line: null,
          why: "main-function",
          detail: null,
          areaId: areaIdOf(f.path),
        });
      }
    }
    const routes: RepoEntryPoint[] = [...nodeById.values()]
      .filter((n) => n.kind === "ENDPOINT" && nodeFile.has(n.id))
      .sort((a, b) => cmp(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0) || cmp(a.name, b.name))
      .map((n) => ({
        name: n.name,
        kind: "ENDPOINT",
        file: n.file,
        line: n.line,
        why: "route" as const,
        detail: n.name,
        areaId: areaIdOf(n.file),
      }));
    const roots: RepoEntryPoint[] = [];
    const perFile = new Map<string, number>();
    const rootCandidates = [...nodeById.values()]
      .filter(
        (n) =>
          nodeFile.has(n.id) &&
          (n.kind === "METHOD" || n.kind === "FUNCTION") &&
          !hasIncoming.has(n.id) &&
          (outgoing.get(n.id) ?? 0) >= 5 &&
          n.name !== "main",
      )
      .sort(
        (a, b) =>
          (outgoing.get(b.id) ?? 0) - (outgoing.get(a.id) ?? 0) ||
          cmp(a.name, b.name) ||
          cmp(a.file, b.file) ||
          (a.line ?? 0) - (b.line ?? 0),
      );
    const perArea = new Map<string | null, number>();
    for (const n of rootCandidates) {
      const area = areaIdOf(n.file);
      // A spread over the repo, not the ten busiest functions of one extractor.
      if ((perFile.get(n.file) ?? 0) >= 1 || (perArea.get(area) ?? 0) >= 3) continue;
      perFile.set(n.file, (perFile.get(n.file) ?? 0) + 1);
      perArea.set(area, (perArea.get(area) ?? 0) + 1);
      roots.push({
        name: n.name,
        kind: n.kind,
        file: n.file,
        line: n.line,
        why: "root",
        detail: `calls ${outgoing.get(n.id)} others, nothing calls it`,
        areaId: areaIdOf(n.file),
      });
    }
    // Priority order with a cap per class first, then whatever room is left in the same order.
    const picked: RepoEntryPoint[] = [];
    const take = (list: RepoEntryPoint[], cap: number) => {
      for (const e of list) {
        if (picked.length >= MAX_ENTRY_POINTS || cap <= 0) return;
        if (picked.includes(e)) continue;
        picked.push(e);
        cap -= 1;
      }
    };
    take(pkg, 6);
    take(mains, 5);
    take(routes, 5);
    take(roots, MAX_ENTRY_POINTS);
    take(pkg, MAX_ENTRY_POINTS);
    take(mains, MAX_ENTRY_POINTS);
    take(routes, MAX_ENTRY_POINTS);
    // Present them grouped as they were taken: manifests, mains, routes, roots (stable).
    const rank = (e: RepoEntryPoint): number =>
      e.why === "package-bin"
        ? 0
        : e.why === "package-main"
          ? 1
          : e.why === "main-function"
            ? 2
            : e.why === "route"
              ? 3
              : 4;
    return picked
      .map((e, i) => [e, i] as const)
      .sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1])
      .map((x) => x[0]);
  }

  // ---- hubs
  const hubs: RepoHub[] = [];
  for (const m of metrics) {
    if (hubs.length >= MAX_HUBS) break;
    const own = areaOfFile[nodeFile.get(m.node.id)!]!;
    const reached = new Set<number>();
    for (const f of deps.get(m.node.id)!.files)
      if (areaOfFile[f]! !== own) reached.add(areaOfFile[f]!);
    hubs.push({
      name: m.node.name,
      kind: m.node.kind,
      file: m.node.file,
      line: m.node.line,
      dependents: m.dependents,
      dependentFiles: m.dependentFiles,
      areasReached: reached.size,
      heuristicShare: round2(m.heuristicShare),
      doc: docOf(m.node),
      areaId: areaNames[own]?.id ?? null,
    });
  }

  // ---- area links and bridges (second pass over the file graph / pairs)
  const A = areaFiles.length;
  const linkEdges = new Map<number, number>(); // a*A+b directed declaration pairs
  interface PairStat {
    edges: number;
    byTo: Map<number, number>;
    byFrom: Map<number, number>;
    top: Array<{ from: ReportNode; to: ReportNode; rank: number }>;
  }
  const pairStats = new Map<number, PairStat>();
  for (const p of input.pairs) {
    const fa = nodeFile.get(p.from);
    const fb = nodeFile.get(p.to);
    if (fa === undefined || fb === undefined || p.from === p.to) continue;
    const aa = areaOfFile[fa]!;
    const ab = areaOfFile[fb]!;
    if (aa === ab || aa < 0 || ab < 0) continue;
    if (
      p.imports === 0 &&
      isGenericName(nodeById.get(p.to)!.name) &&
      DECL_KINDS.has(nodeById.get(p.to)!.kind)
    )
      continue;
    const key = aa * A + ab;
    linkEdges.set(key, (linkEdges.get(key) ?? 0) + 1);
    const a = nodeById.get(p.from)!;
    const b = nodeById.get(p.to)!;
    if (!DECL_KINDS.has(a.kind) || !DECL_KINDS.has(b.kind)) continue;
    const st: PairStat = pairStats.get(key) ?? {
      edges: 0,
      byTo: new Map(),
      byFrom: new Map(),
      top: [],
    };
    st.edges += 1;
    st.byTo.set(p.to, (st.byTo.get(p.to) ?? 0) + 1);
    st.byFrom.set(p.from, (st.byFrom.get(p.from) ?? 0) + 1);
    const rank = deps.get(p.to)?.total ?? 0;
    st.top.push({ from: a, to: b, rank });
    if (st.top.length > 24) {
      st.top.sort(exampleOrder);
      st.top.length = 12;
    }
    pairStats.set(key, st);
  }
  const linksOf = (a: number, dir: "out" | "in"): RepoAreaLink[] => {
    const rows: Array<{ id: number; n: number }> = [];
    for (let b = 0; b < A; b += 1) {
      if (b === a) continue;
      const n = dir === "out" ? (linkEdges.get(a * A + b) ?? 0) : (linkEdges.get(b * A + a) ?? 0);
      if (n > 0) rows.push({ id: b, n });
    }
    rows.sort((x, y) => y.n - x.n || cmp(areaNames[x.id]!.name, areaNames[y.id]!.name));
    return rows.slice(0, 5).map((r) => ({ areaId: areaNames[r.id]!.id, edges: r.n }));
  };
  const ref = (n: ReportNode): RepoSymbolRef => ({
    name: n.name,
    kind: n.kind,
    file: n.file,
    line: n.line,
  });
  const bridges = buildBridges();

  function exampleOrder(
    x: { from: ReportNode; to: ReportNode; rank: number },
    y: { from: ReportNode; to: ReportNode; rank: number },
  ): number {
    return (
      y.rank - x.rank ||
      cmp(x.to.name, y.to.name) ||
      cmp(x.from.name, y.from.name) ||
      cmp(x.from.file, y.from.file) ||
      cmp(x.to.file, y.to.file)
    );
  }
  function buildBridges(): RepoBridge[] {
    const exampleList = (st: PairStat, prefer?: number): RepoBridge["examples"] => {
      const sorted = [...st.top].sort(exampleOrder);
      const out: Array<{ from: ReportNode; to: ReportNode }> = [];
      const used = new Set<string>();
      const add = (e: { from: ReportNode; to: ReportNode }) => {
        const k = `${e.from.id}>${e.to.id}`;
        if (out.length < 3 && !used.has(k)) {
          used.add(k);
          out.push(e);
        }
      };
      if (prefer !== undefined)
        for (const e of sorted) if (e.to.id === prefer || e.from.id === prefer) add(e);
      // Different targets first: three examples of one function say less than three functions.
      const targets = new Set(out.map((e) => e.to.id));
      for (const e of sorted)
        if (!targets.has(e.to.id)) {
          targets.add(e.to.id);
          add(e);
        }
      for (const e of sorted) add(e);
      return out.map((e) => ({ from: ref(e.from), to: ref(e.to) }));
    };
    const all = [...pairStats]
      .map(([key, st]) => ({ a: Math.floor(key / A), b: key % A, st }))
      .sort((x, y) => y.st.edges - x.st.edges || x.a - y.a || x.b - y.b);
    const used = new Set<string>();
    const out: RepoBridge[] = [];
    const push = (
      x: { a: number; b: number; st: PairStat },
      why: RepoBridge["why"],
      prefer?: number,
    ) => {
      const k = `${x.a}>${x.b}`;
      if (used.has(k) || out.length >= MAX_BRIDGES) return;
      used.add(k);
      out.push({
        from: areaNames[x.a]!.id,
        to: areaNames[x.b]!.id,
        edges: x.st.edges,
        why,
        examples: exampleList(x.st, prefer),
      });
    };
    // single-point: nearly all of an area pair's dependencies funnel through one declaration.
    const waists: Array<{ x: (typeof all)[number]; id: number; share: number }> = [];
    for (const x of all) {
      if (x.st.edges < 4) continue;
      const topTo = [...x.st.byTo].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0]!;
      const topFrom = [...x.st.byFrom].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0]!;
      const funnel = topTo[1] >= topFrom[1] && x.st.byFrom.size >= 3 ? topTo : topFrom;
      const wide = funnel === topTo ? x.st.byFrom.size : x.st.byTo.size;
      if (funnel[1] / x.st.edges >= 0.7 && wide >= 3)
        waists.push({ x, id: funnel[0], share: funnel[1] / x.st.edges });
    }
    waists.sort((p, q) => q.x.st.edges - p.x.st.edges || q.share - p.share);
    for (const w of waists.slice(0, 2)) push(w.x, "single-point", w.id);
    // strongest: the heaviest cross-area dependencies.
    let strong = 0;
    for (const x of all) {
      if (strong >= 4) break;
      if (!used.has(`${x.a}>${x.b}`)) {
        push(x, "strongest");
        strong += 1;
      }
    }
    // unexpected: areas far apart in the tree that barely touch (a thin line between two big areas).
    const sizeOf = (a: number): number => areaFiles[a]!.length;
    const prefixOf = (a: number): string[] => areaNames[a]!.primaryDir.split("/").filter(Boolean);
    const unexpected = all
      .filter((x) => {
        const back = pairStats.get(x.b * A + x.a)?.edges ?? 0;
        if (x.st.edges + back > 3) return false;
        const pa = prefixOf(x.a);
        const pb = prefixOf(x.b);
        return pa.length > 0 && pb.length > 0 && pa[0] !== pb[0];
      })
      .sort(
        (p, q) =>
          Math.min(sizeOf(q.a), sizeOf(q.b)) - Math.min(sizeOf(p.a), sizeOf(p.b)) ||
          p.st.edges - q.st.edges ||
          p.a - q.a ||
          p.b - q.b,
      );
    let odd = 0;
    for (const x of unexpected) {
      if (odd >= 2) break;
      if (!used.has(`${x.a}>${x.b}`)) {
        push(x, "unexpected");
        odd += 1;
      }
    }
    return out;
  }

  // ---- areas
  const keySymbolsByArea = new Map<number, Metric[]>();
  for (const m of metrics) {
    const a = areaOfFile[nodeFile.get(m.node.id)!]!;
    const list = keySymbolsByArea.get(a) ?? [];
    if (list.length < 5) {
      list.push(m);
      keySymbolsByArea.set(a, list);
    }
  }
  const testsByArea = new Int32Array(A);
  const stemIndex = new Map<string, number[]>();
  for (let i = 0; i < F; i += 1) {
    const stem = baseOf(included[i]!.path)
      .replace(/\.[^.]+$/, "")
      .toLowerCase();
    const list = stemIndex.get(stem) ?? [];
    list.push(i);
    stemIndex.set(stem, list);
  }
  for (const t of testFilePaths) {
    const votes = testVotes.get(t);
    let area = -1;
    if (votes) {
      const byArea = new Map<number, number>();
      for (const [f, n] of votes) byArea.set(areaOfFile[f]!, (byArea.get(areaOfFile[f]!) ?? 0) + n);
      area = [...byArea].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]![0];
    } else {
      // No edge to go by: a `foo.test.ts` / `test_foo.py` / `foo_test.go` next to or named after `foo`.
      const stem = baseOf(t)
        .replace(/\.[^.]+$/, "")
        .replace(/\.(test|spec)$/i, "")
        .replace(/^test_/i, "")
        .replace(/_(test|spec)$/i, "")
        .toLowerCase();
      const cand = stemIndex.get(stem);
      if (cand?.length) {
        const same = cand.find((i) => included[i]!.dir === dirOf(t)) ?? cand[0]!;
        area = areaOfFile[same]!;
      }
    }
    if (area >= 0) testsByArea[area]! += 1;
  }
  const entryByArea = new Map<string, RepoEntryPoint>();
  for (const e of entryPoints) {
    if (e.areaId && e.why !== "root" && !entryByArea.has(e.areaId)) entryByArea.set(e.areaId, e);
  }
  const areas: RepoArea[] = areaFiles.map((files, a) => {
    const nm = areaNames[a]!;
    const dirCount = new Map<string, number>();
    for (const f of files)
      dirCount.set(included[f]!.dir, (dirCount.get(included[f]!.dir) ?? 0) + 1);
    const dirs = [...dirCount]
      .sort((x, y) => y[1] - x[1] || cmp(x[0], y[0]))
      .slice(0, 4)
      .map((d) => d[0] || ".");
    const keyFiles = [...files]
      .filter((f) => fileDependents[f]! > 0)
      .sort(
        (x, y) =>
          fileDependents[y]! - fileDependents[x]! || cmp(included[x]!.path, included[y]!.path),
      )
      .slice(0, 5)
      .map((f) => ({ file: included[f]!.path, dependents: fileDependents[f]! }));
    const keySymbols = (keySymbolsByArea.get(a) ?? []).map((m) => ({
      ...ref(m.node),
      dependents: m.dependents,
      doc: docOf(m.node),
    }));
    let decls = 0;
    for (const f of files) decls += declsPerFile[f]!;
    const start = entryByArea.get(nm.id);
    const summary =
      `${files.length} file${files.length === 1 ? "" : "s"}, ${decls} declaration${decls === 1 ? "" : "s"}.` +
      (start ? ` Starts at ${start.file}.` : "") +
      (keySymbols[0]
        ? ` Most used: ${keySymbols[0].name} (${keySymbols[0].dependents} dependents).`
        : "");
    return {
      id: nm.id,
      name: nm.name,
      dirs,
      files: files.length,
      declarations: decls,
      testFiles: testsByArea[a]!,
      keyFiles,
      keySymbols,
      uses: linksOf(a, "out"),
      usedBy: linksOf(a, "in"),
      summary,
    };
  });
  // Biggest area first (ties by name); the id order of everything above followed the detection order.
  areas.sort((x, y) => y.files - x.files || cmp(x.name, y.name));

  // ---- hotspots, cycles, notes
  const hotspots: RepoHotspot[] = (input.history ?? [])
    .filter((h) => fileIndex.has(h.file) && h.commits > 0)
    .sort((x, y) => y.commits - x.commits || cmp(x.file, y.file))
    .slice(0, MAX_HOTSPOTS)
    .map((h) => ({ file: h.file, commits: h.commits, changesWith: h.changesWith.slice(0, 3) }));
  const cycles = findCycles(
    included.map((f) => f.path),
    importAdj,
  );
  const notes = buildNotes();

  function buildNotes(): RepoNote[] {
    const TAGS = ["WARNING", "HACK", "FIXME", "WHY", "NOTE", "TODO"];
    const re = /(?:^|[\s>*#\-/(])(WARNING|HACK|FIXME|WHY|NOTE|TODO)\b\s*[:\-—)(]\s*/;
    const found: Array<{ tag: string; row: ReportNoteRow }> = [];
    for (const r of input.noteRows) {
      const cls = classifyPath(r.file);
      if (cls !== "source" && !(r.kind === "DOC" && cls === "doc")) continue;
      const m = re.exec(r.text);
      if (m) found.push({ tag: m[1]!, row: r });
    }
    found.sort(
      (x, y) =>
        TAGS.indexOf(x.tag) - TAGS.indexOf(y.tag) ||
        cmp(x.row.file, y.row.file) ||
        (x.row.line ?? 0) - (y.row.line ?? 0),
    );
    const out: RepoNote[] = [];
    for (const { tag, row } of found) {
      if (out.length >= MAX_NOTES) break;
      const m = re.exec(row.text)!;
      let text = row.text
        .slice(m.index + m[0].length)
        .replace(/\s+/g, " ")
        .trim();
      if (text.length > 200) text = `${text.slice(0, 199).trimEnd()}…`;
      if (!text) continue;
      const owner = [...nodeById.values()]
        .filter(
          (n) =>
            n.file === row.file &&
            DECL_KINDS.has(n.kind) &&
            n.line &&
            row.line &&
            n.line <= row.line &&
            (n.endLine ?? n.line) >= row.line,
        )
        .sort((x, y) => (y.line ?? 0) - (x.line ?? 0))[0];
      out.push({
        name: owner?.name ?? baseOf(row.file),
        kind: row.kind,
        file: row.file,
        line: row.line,
        tag,
        text,
      });
    }
    return out;
  }

  // ---- fileAreas, languages, stats
  const fileAreas: Record<string, string> = {};
  const order = [...Array(F).keys()].sort(
    (x, y) => degree[y]! - degree[x]! || cmp(included[x]!.path, included[y]!.path),
  );
  const keep = F > MAX_FILE_AREAS ? new Set(order.slice(0, MAX_FILE_AREAS)) : null;
  for (let i = 0; i < F; i += 1) {
    if (keep && !keep.has(i)) continue;
    const area = areaOfFile[i]!;
    if (area >= 0) fileAreas[included[i]!.path] = areaNames[area]!.id;
  }
  const langCount = new Map<string, number>();
  for (const f of included)
    if (f.language) langCount.set(f.language, (langCount.get(f.language) ?? 0) + 1);
  const languages = [...langCount]
    .sort((x, y) => y[1] - x[1] || cmp(x[0], y[0]))
    .map(([language, files]) => ({ language, files }));
  const heuristicEdgeShare = callEdges === 0 ? 0 : round2(heurEdges / callEdges);

  // ---- caveats
  const caveats: string[] = [];
  if (input.stale) {
    caveats.push(
      input.behindCommits && input.behindCommits > 0
        ? `The index is ${input.behindCommits} commit${input.behindCommits === 1 ? "" : "s"} behind HEAD; recent changes are missing from this map.`
        : "HEAD has moved since the index was built; recent changes are missing from this map.",
    );
  }
  const otherExcluded =
    (classCount.get("fixture") ?? 0) +
    (classCount.get("bench") ?? 0) +
    (classCount.get("example") ?? 0) +
    (classCount.get("vendored") ?? 0) +
    (classCount.get("generated") ?? 0) +
    (classCount.get("build") ?? 0) +
    (classCount.get("doc") ?? 0) +
    (classCount.get("tooling") ?? 0);
  if (testFilePaths.length || otherExcluded)
    caveats.push(
      `Left out of areas, hubs and entry points: ${testFilePaths.length} test file${testFilePaths.length === 1 ? "" : "s"} (counted per area instead)` +
        (otherExcluded
          ? ` and ${otherExcluded} fixture, benchmark, example, vendored, generated, build, docs or tooling file${otherExcluded === 1 ? "" : "s"}.`
          : "."),
    );
  if (heuristicEdgeShare >= 0.2)
    caveats.push(
      `${Math.round(heuristicEdgeShare * 100)}% of call edges are name-matched guesses (a dynamic language, or calls the resolver could not follow): areas and hubs lean on them at half weight, and hubs that rest mostly on them say so.`,
    );
  if (skippedGeneric > 0)
    caveats.push(
      `${skippedGeneric} calls to generic method names (get, set, copy, open, dumps and the like) are not counted as dependencies: a call to one cannot be told apart from the standard library's.`,
    );
  if (!input.history || input.history.length === 0)
    caveats.push(
      input.repoOnDisk
        ? "No git history could be read, so what changes most is empty."
        : "The repository folder is not on disk, so manifests (entry points) and git history (what changes most) are missing.",
    );
  if (rawAreaCount > MAX_AREAS)
    caveats.push(`${rawAreaCount} communities were merged down to ${MAX_AREAS} areas.`);
  if (keep) caveats.push(`The graph view colours the ${MAX_FILE_AREAS} best-connected files only.`);
  if (F === 0) caveats.push("No source files were found in the index.");

  const report: RepoReport = {
    version: REPO_REPORT_VERSION,
    repo: input.repo,
    branch: input.branch,
    indexedSha: input.indexedSha,
    stale: input.stale,
    generatedAt: input.generatedAt,
    stats: {
      files: F,
      declarations,
      edges: edgeCount,
      testFiles: testFilePaths.length,
      heuristicEdgeShare,
      languages,
    },
    areas,
    hubs,
    entryPoints,
    bridges,
    hotspots,
    cycles,
    notes,
    questions: buildQuestions(
      areas,
      hubs,
      entryPoints,
      bridges,
      metrics,
      nameCount,
      included,
      fileDependents,
    ),
    fileAreas,
    caveats,
  };
  return report;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

// ---------------------------------------------------------------- areas: grouping, merging, naming

function detectAreas(
  files: ReadonlyArray<FileRec>,
  edges: ReadonlyArray<WeightedEdge>,
  degree: Int32Array,
): { groups: number[][]; rawCount: number } {
  const F = files.length;
  if (F === 0) return { groups: [], rawCount: 0 };
  const label = louvain(F, edges);
  const gg = new GroupGraph();
  const groupOf = new Int32Array(F).fill(-1);
  const byLabel = new Map<number, number[]>();
  for (let i = 0; i < F; i += 1) {
    if (degree[i] === 0) continue; // files with no dependency edges are placed by directory below
    const l = label[i]!;
    const list = byLabel.get(l) ?? [];
    list.push(i);
    byLabel.set(l, list);
  }
  for (const l of [...byLabel.keys()].sort((x, y) => x - y)) {
    const members = byLabel.get(l)!;
    const id = gg.add(members);
    for (const f of members) groupOf[f] = id;
  }
  const linkAll = (): void => {
    for (const e of edges) {
      const ga = groupOf[e.a]!;
      const gb = groupOf[e.b]!;
      if (ga >= 0 && gb >= 0) gg.link(ga, gb, e.w);
    }
  };
  linkAll();
  const isolated: number[] = [];
  for (let i = 0; i < F; i += 1) if (degree[i] === 0) isolated.push(i);

  const minPath = (id: number): string => files[Math.min(...gg.members.get(id)!)]!.path;
  const mergeSmall = (limit: number): void => {
    for (;;) {
      let pick = -1;
      for (const [id, m] of gg.members) {
        if (m.length >= limit || gg.members.size <= 1) continue;
        const links = gg.links.get(id)!;
        if (links.size === 0) continue;
        if (
          pick < 0 ||
          m.length < gg.members.get(pick)!.length ||
          (m.length === gg.members.get(pick)!.length && cmp(minPath(id), minPath(pick)) < 0)
        )
          pick = id;
      }
      if (pick < 0) return;
      gg.merge(pick, bestNeighbour(pick));
    }
  };
  const bestNeighbour = (id: number): number => {
    let best = -1;
    let bw = -1;
    for (const [c, w] of gg.links.get(id)!) {
      if (w > bw || (w === bw && cmp(minPath(c), minPath(best)) < 0)) {
        best = c;
        bw = w;
      }
    }
    return best;
  };
  mergeSmall(MIN_AREA_FILES);

  // Files with no dependency edges: the area that already holds most files of their directory, else their own directory.
  const dirOwner = new Map<string, Map<number, number>>();
  for (const [id, members] of gg.members)
    for (const f of members) {
      const m = dirOwner.get(files[f]!.dir) ?? new Map<number, number>();
      m.set(id, (m.get(id) ?? 0) + 1);
      dirOwner.set(files[f]!.dir, m);
    }
  const ownerOf = (dir: string): number | null => {
    const m = dirOwner.get(dir);
    if (!m) return null;
    return [...m].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]![0];
  };
  const loose = new Map<string, number[]>();
  for (const f of isolated) {
    const dir = files[f]!.dir;
    const owner = ownerOf(dir) ?? ownerOf(dirOf(dir));
    if (owner !== null && gg.members.has(owner)) gg.members.get(owner)!.push(f);
    else {
      const list = loose.get(dir) ?? [];
      list.push(f);
      loose.set(dir, list);
    }
  }
  for (const dir of [...loose.keys()].sort(cmp)) gg.add(loose.get(dir)!);

  // Anything still under the minimum (no links at all): the group sharing the longest directory prefix, else the biggest.
  const primary = (id: number): string => topDir(gg.members.get(id)!, files);
  const nearest = (id: number): number => {
    const mine = primary(id).split("/").filter(Boolean);
    let best = -1;
    let bestScore = -1;
    for (const c of gg.members.keys()) {
      if (c === id) continue;
      const other = primary(c).split("/").filter(Boolean);
      let k = 0;
      while (k < mine.length && k < other.length && mine[k] === other[k]) k += 1;
      const score = k * 100000 + gg.members.get(c)!.length;
      if (score > bestScore || (score === bestScore && cmp(minPath(c), minPath(best)) < 0)) {
        best = c;
        bestScore = score;
      }
    }
    return best;
  };
  const shrink = (limit: number, force: boolean): void => {
    for (;;) {
      if (gg.members.size <= 1) return;
      let pick = -1;
      for (const [id, m] of gg.members) {
        if (!force && m.length >= limit) continue;
        if (
          pick < 0 ||
          m.length < gg.members.get(pick)!.length ||
          (m.length === gg.members.get(pick)!.length && cmp(minPath(id), minPath(pick)) < 0)
        )
          pick = id;
      }
      if (pick < 0) return;
      if (!force && gg.members.size <= 1) return;
      const links = gg.links.get(pick)!;
      gg.merge(pick, links.size > 0 ? bestNeighbour(pick) : nearest(pick));
      if (force && gg.members.size <= limit) return;
    }
  };
  // Small groups that survived (a loose directory of two files) go to their nearest sibling, unless nothing else exists.
  if (gg.members.size > 1) {
    for (;;) {
      let pick = -1;
      for (const [id, m] of gg.members) {
        if (m.length >= MIN_AREA_FILES) continue;
        if (
          pick < 0 ||
          m.length < gg.members.get(pick)!.length ||
          (m.length === gg.members.get(pick)!.length && cmp(minPath(id), minPath(pick)) < 0)
        )
          pick = id;
      }
      if (pick < 0 || gg.members.size <= 1) break;
      gg.merge(pick, gg.links.get(pick)!.size > 0 ? bestNeighbour(pick) : nearest(pick));
    }
  }
  const rawCount = gg.members.size;
  if (rawCount > MAX_AREAS) shrink(MAX_AREAS, true);
  const groups = [...gg.members.values()].map((m) => [...m].sort((x, y) => x - y));
  groups.sort((x, y) => cmp(files[x[0]!]!.path, files[y[0]!]!.path));
  return { groups, rawCount };
}

/** The directory (without `src`-style containers) most of a file set lives in. */
function topDir(members: ReadonlyArray<number>, files: ReadonlyArray<FileRec>): string {
  const count = new Map<string, number>();
  for (const f of members) {
    const d = stripContainers(files[f]!.dir);
    count.set(d, (count.get(d) ?? 0) + 1);
  }
  return [...count].sort((x, y) => y[1] - x[1] || cmp(x[0], y[0]))[0]?.[0] ?? "";
}

const CONTAINER_SEGS = new Set(["src", "source", "sources"]);
const stripContainers = (dir: string): string =>
  dir
    .split("/")
    .filter((s) => s && !CONTAINER_SEGS.has(s.toLowerCase()))
    .join("/");

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "root";

interface AreaName {
  readonly id: string;
  readonly name: string;
  /** The directory (containers stripped) most of its files share; "" for the repo root. */
  readonly primaryDir: string;
}

/** Words of a file name ("graph-expansion-policy" -> graph, expansion, policy; "parseArgs" -> parse, args). */
function words(stem: string): string[] {
  return stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}
const GENERIC_WORDS = new Set([
  "index",
  "main",
  "util",
  "utils",
  "common",
  "base",
  "core",
  "lib",
  "types",
  "type",
  "helpers",
  "helper",
  "test",
  "tests",
  "spec",
  "src",
  "the",
  "and",
]);

/**
 * Names by the directory that holds most of an area's files; unique in the report. When two areas share a directory the
 * later (smaller) one is told apart by the word most of its file names share ("services/graph"), then by its most depended-on
 * file's name, then by a counter.
 */
function nameAreas(
  files: ReadonlyArray<FileRec>,
  areaFiles: ReadonlyArray<ReadonlyArray<number>>,
  fileDependents: Int32Array,
): AreaName[] {
  const used = new Set<string>();
  const taken = (c: string): boolean => used.has(c) || used.has(`slug:${slug(c)}`);
  const out: AreaName[] = Array.from({ length: areaFiles.length });
  const order = areaFiles
    .map((_, i) => i)
    .sort(
      (x, y) =>
        areaFiles[y]!.length - areaFiles[x]!.length ||
        cmp(files[areaFiles[x]![0]!]!.path, files[areaFiles[y]![0]!]!.path),
    );
  for (const a of order) {
    const members = areaFiles[a]!;
    const dir = topDir(members, files);
    const segs = dir.split("/").filter(Boolean);
    const candidates: string[] = [];
    if (segs.length === 0) candidates.push("root");
    else
      for (let k = 1; k <= segs.length; k += 1)
        candidates.push(segs.slice(segs.length - k).join("/"));
    const head = candidates[0]!;
    // Different directories first (a longer tail), then the word its file names share, then its busiest file.
    const wordCount = new Map<string, number>();
    for (const f of members) {
      for (const w of new Set(words(baseOf(files[f]!.path).replace(/\.[^.]+$/, ""))))
        if (!GENERIC_WORDS.has(w)) wordCount.set(w, (wordCount.get(w) ?? 0) + 1);
    }
    const shared = [...wordCount]
      .filter(([, n]) => n >= 2 || members.length <= 2)
      .sort((x, y) => y[1] - x[1] || cmp(x[0], y[0]));
    for (const [w] of shared.slice(0, 3)) candidates.push(`${head}/${w}`);
    const busiest = [...members].sort(
      (x, y) => fileDependents[y]! - fileDependents[x]! || cmp(files[x]!.path, files[y]!.path),
    )[0]!;
    candidates.push(`${head}/${baseOf(files[busiest]!.path).replace(/\.[^.]+$/, "")}`);
    let name = candidates.find((c) => !taken(c));
    for (let n = 2; !name; n += 1) {
      const c = `${candidates[candidates.length - 1]} ${n}`;
      if (!taken(c)) name = c;
    }
    used.add(name);
    used.add(`slug:${slug(name)}`);
    out[a] = { id: slug(name), name, primaryDir: dir };
  }
  return out;
}

// ---------------------------------------------------------------- import cycles

/** One cycle per strongly connected component of the file import graph (shortest through its first file), shortest first. */
function findCycles(
  paths: ReadonlyArray<string>,
  adj: ReadonlyMap<number, ReadonlySet<number>>,
): string[][] {
  const N = paths.length;
  const succ = (v: number): number[] => [...(adj.get(v) ?? [])].sort((x, y) => x - y);
  // Tarjan, iterative.
  const index = new Int32Array(N).fill(-1);
  const low = new Int32Array(N);
  const onStack = new Uint8Array(N);
  const stack: number[] = [];
  const sccs: number[][] = [];
  let counter = 0;
  for (let s = 0; s < N; s += 1) {
    if (index[s]! >= 0 || !adj.has(s)) continue;
    const work: Array<{ v: number; next: number[]; i: number }> = [{ v: s, next: succ(s), i: 0 }];
    index[s] = low[s] = counter++;
    stack.push(s);
    onStack[s] = 1;
    while (work.length) {
      const top = work[work.length - 1]!;
      if (top.i < top.next.length) {
        const w = top.next[top.i++]!;
        if (index[w]! < 0) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push({ v: w, next: succ(w), i: 0 });
        } else if (onStack[w]) low[top.v] = Math.min(low[top.v]!, index[w]!);
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1]!.v;
          low[parent] = Math.min(low[parent]!, low[top.v]!);
        }
        if (low[top.v] === index[top.v]) {
          const comp: number[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack[w] = 0;
            comp.push(w);
            if (w === top.v) break;
          }
          if (comp.length > 1) sccs.push(comp);
        }
      }
    }
  }
  const cycles: number[][] = [];
  for (const comp of sccs) {
    const inComp = new Set(comp);
    const start = Math.min(...comp); // paths are sorted: the lowest index is the first path
    // BFS from start; the shortest way back to start closes the shortest cycle through it.
    const prev = new Map<number, number>([[start, -1]]);
    const queue = [start];
    let closing = -1;
    for (let qi = 0; qi < queue.length && closing < 0; qi += 1) {
      const v = queue[qi]!;
      for (const w of succ(v)) {
        if (!inComp.has(w)) continue;
        if (w === start) {
          closing = v;
          break;
        }
        if (!prev.has(w)) {
          prev.set(w, v);
          queue.push(w);
        }
      }
    }
    if (closing < 0) continue;
    const cyc: number[] = [];
    for (let v = closing; v >= 0; v = prev.get(v)!) cyc.push(v);
    cycles.push(cyc.toReversed());
  }
  cycles.sort((x, y) => x.length - y.length || cmp(paths[x[0]!]!, paths[y[0]!]!));
  return cycles.slice(0, MAX_CYCLES).map((c) => c.map((i) => paths[i]!));
}

// ---------------------------------------------------------------- manifests

/** A manifest path ("./dist/cli.js", "bin/tool") to the file the graph holds: as written, else the source behind a build path. */
export function resolveManifestFile(raw: string, live: ReadonlySet<string>): string | null {
  const clean = raw.replace(/^\.\//, "").replace(/^\/+/, "");
  if (!clean || clean.includes("..")) return null;
  if (live.has(clean)) return clean;
  const stem = clean.replace(/\.[^./]+$/, "");
  const tries = [
    clean.replace(/^(dist|build|lib|out)\//, "src/"),
    clean.replace(/^(dist|build|lib|out)\//, ""),
  ];
  for (const t of tries) {
    const s = t.replace(/\.[^./]+$/, "");
    for (const ext of ["ts", "tsx", "js", "mjs", "cjs", "jsx"])
      if (live.has(`${s}.${ext}`)) return `${s}.${ext}`;
    if (live.has(t)) return t;
  }
  for (const ext of ["ts", "tsx", "js", "mjs", "cjs"])
    if (live.has(`${stem}.${ext}`)) return `${stem}.${ext}`;
  return null;
}

/** Entry points declared by package manifests under a repo root (root, plus one level of workspace folders), read from disk. */
export function readManifests(root: string): ReportManifestEntry[] {
  const out: ReportManifestEntry[] = [];
  const read = (rel: string): string | null => {
    try {
      const f = path.join(root, rel);
      const st = fs.statSync(f);
      if (!st.isFile() || st.size > 512 * 1024) return null;
      return fs.readFileSync(f, "utf8");
    } catch {
      return null;
    }
  };
  const join = (dir: string, file: string): string =>
    (dir ? `${dir}/${file}` : file).replace(/^\.\//, "");
  const dirs = [""];
  const wsDirs = (patterns: unknown): string[] => {
    const res: string[] = [];
    if (!Array.isArray(patterns)) return res;
    for (const p of patterns) {
      if (typeof p !== "string") continue;
      const m = /^([^*]+)\/\*$/.exec(p.replace(/^\.\//, ""));
      if (!m) continue;
      try {
        for (const e of fs.readdirSync(path.join(root, m[1]!), { withFileTypes: true }))
          if (e.isDirectory() && !e.name.startsWith(".")) res.push(`${m[1]}/${e.name}`);
      } catch {
        /* no such folder */
      }
    }
    return res;
  };
  const rootPkg = read("package.json");
  let ws: string[] = [];
  if (rootPkg) {
    try {
      const j = JSON.parse(rootPkg) as { workspaces?: unknown };
      const w = Array.isArray(j.workspaces)
        ? j.workspaces
        : ((j.workspaces as { packages?: unknown } | undefined)?.packages ?? []);
      ws = wsDirs(w);
    } catch {
      /* not json */
    }
  }
  if (ws.length === 0) ws = wsDirs(["packages/*", "apps/*", "services/*", "crates/*"]);
  for (const d of ws.sort(cmp).slice(0, 40)) dirs.push(d);
  for (const dir of dirs) {
    const pkgText = read(join(dir, "package.json"));
    if (pkgText) {
      try {
        const j = JSON.parse(pkgText) as {
          name?: string;
          bin?: unknown;
          main?: unknown;
          module?: unknown;
          exports?: unknown;
        };
        const pkgName = typeof j.name === "string" ? j.name : baseOf(dir) || "package";
        if (typeof j.bin === "string")
          out.push({
            file: join(dir, j.bin),
            why: "package-bin",
            name: pkgName,
            detail: `bin ${pkgName}`,
          });
        else if (j.bin && typeof j.bin === "object")
          for (const [bn, bf] of Object.entries(j.bin as Record<string, unknown>).sort((x, y) =>
            cmp(x[0], y[0]),
          ))
            if (typeof bf === "string")
              out.push({ file: join(dir, bf), why: "package-bin", name: bn, detail: `bin ${bn}` });
        const mains: string[] = [];
        if (typeof j.main === "string") mains.push(j.main);
        if (typeof j.module === "string") mains.push(j.module);
        const ex = j.exports;
        if (typeof ex === "string") mains.push(ex);
        else if (ex && typeof ex === "object") {
          const root0 = (ex as Record<string, unknown>)["."] ?? ex;
          const pick = (v: unknown): string | null => {
            if (typeof v === "string") return v;
            if (v && typeof v === "object")
              for (const k of ["import", "default", "require", "node", "types"]) {
                const r = pick((v as Record<string, unknown>)[k]);
                if (r) return r;
              }
            return null;
          };
          const r = pick(root0);
          if (r) mains.push(r);
        }
        for (const m of new Set(mains))
          out.push({
            file: join(dir, m),
            why: "package-main",
            name: pkgName,
            detail: `main of ${pkgName}`,
          });
      } catch {
        /* not json */
      }
    }
    const py = read(join(dir, "pyproject.toml"));
    if (py) {
      const sec = /\[project\.scripts\]([\s\S]*?)(?:\n\[|$)/.exec(py)?.[1] ?? "";
      for (const line of sec.split("\n")) {
        const m = /^\s*([\w.-]+)\s*=\s*["']([\w.]+):[\w.]+["']/.exec(line);
        if (m) {
          const mod = m[2]!.replace(/\./g, "/");
          out.push({
            file: join(dir, `${mod}.py`),
            why: "package-bin",
            name: m[1]!,
            detail: `script ${m[1]}`,
          });
          out.push({
            file: join(dir, `src/${mod}.py`),
            why: "package-bin",
            name: m[1]!,
            detail: `script ${m[1]}`,
          });
        }
      }
    }
    const cargo = read(join(dir, "Cargo.toml"));
    if (cargo) {
      const pkgName =
        /\[package\][\s\S]*?\bname\s*=\s*"([^"]+)"/.exec(cargo)?.[1] ?? (baseOf(dir) || "crate");
      const bins = [...cargo.matchAll(/\[\[bin\]\]([\s\S]*?)(?=\n\[|$)/g)];
      for (const b of bins) {
        const bn = /\bname\s*=\s*"([^"]+)"/.exec(b[1]!)?.[1] ?? pkgName;
        const bp = /\bpath\s*=\s*"([^"]+)"/.exec(b[1]!)?.[1] ?? "src/main.rs";
        out.push({ file: join(dir, bp), why: "package-bin", name: bn, detail: `bin ${bn}` });
      }
      if (bins.length === 0)
        out.push({
          file: join(dir, "src/main.rs"),
          why: "package-bin",
          name: pkgName,
          detail: `bin ${pkgName}`,
        });
      out.push({
        file: join(dir, "src/lib.rs"),
        why: "package-main",
        name: pkgName,
        detail: `library ${pkgName}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- questions

function buildQuestions(
  areas: ReadonlyArray<RepoArea>,
  hubs: ReadonlyArray<RepoHub>,
  entryPoints: ReadonlyArray<RepoEntryPoint>,
  bridges: ReadonlyArray<RepoBridge>,
  metrics: ReadonlyArray<{ readonly node: ReportNode }>,
  nameCount: ReadonlyMap<string, number>,
  _files: ReadonlyArray<FileRec>,
  _fileDependents: Int32Array,
): RepoQuestion[] {
  const out: RepoQuestion[] = [];
  const seen = new Set<string>();
  const add = (q: RepoQuestion): void => {
    if (out.length >= 8 || seen.has(q.text)) return;
    seen.add(q.text);
    out.push(q);
  };
  // The quick-answer shapes need a code-shaped, preferably unambiguous, name.
  const askable = (h: RepoHub): boolean =>
    isCodeName(h.name) && (nameCount.get(h.name) ?? 1) === 1 && h.heuristicShare < 0.5;
  const pool = hubs.filter(askable);
  const top = pool[0] ?? hubs.find((h) => isCodeName(h.name));
  if (top) add({ text: `Who calls ${top.name}?`, kind: "callers", target: top.name });
  const impact = pool[1] ?? pool[0] ?? top;
  if (impact)
    add({ text: `What breaks if I change ${impact.name}?`, kind: "impact", target: impact.name });
  const entry = entryPoints.find((e) => e.kind !== "FILE" && isCodeName(e.name));
  if (entry) add({ text: `Where is ${entry.name}?`, kind: "where", target: entry.name });
  const third = pool[2];
  if (third) add({ text: `Who calls ${third.name}?`, kind: "callers", target: third.name });
  const nameOf = (id: string): string => areas.find((a) => a.id === id)?.name ?? id;
  for (const b of bridges) {
    if (out.filter((q) => q.kind === "explore").length >= 2) break;
    add({
      text: `How does ${nameOf(b.from)} use ${nameOf(b.to)}?`,
      kind: "explore",
      target: `${nameOf(b.from)} -> ${nameOf(b.to)}`,
    });
  }
  if (out.length < 4) {
    for (const a of areas.slice(0, 2))
      add({ text: `How does ${a.name} work?`, kind: "explore", target: a.name });
    const e = entryPoints[0];
    if (e) add({ text: `What happens when ${e.file} runs?`, kind: "explore", target: e.file });
    if (top)
      add({
        text: `How is ${top.name} used across the codebase?`,
        kind: "explore",
        target: top.name,
      });
    const m = metrics[0];
    if (m)
      add({ text: `What does ${baseOf(m.node.file)} do?`, kind: "explore", target: m.node.file });
  }
  return out;
}

// ---------------------------------------------------------------- the loader

const NODE_KINDS = [...DECL_KINDS, "FILE", "ENDPOINT", "TEST"];
const DEP_EDGES = ["CALLS", "IMPORTS", "EXTENDS", "IMPLEMENTS", "OVERRIDES", "REFERENCES", "TESTS"];
const sqlList = (xs: ReadonlyArray<string>): string => xs.map((x) => `'${x}'`).join(",");
/**
 * A name-matched guess: HEURISTIC_CALLS, or a CALLS edge the resolver itself put in its guess bands (tiers 7-9: a global
 * label tie-broken among candidates, a bare member name, no candidate; koragraph/src/services/resolution/tiers.js).
 */
const WEAK = `(e.edge_type = 'HEURISTIC_CALLS' OR (e.edge_type = 'CALLS' AND COALESCE(e.resolution_tier, 0) >= 7) OR COALESCE(e.confidence_tier, '') = 'AMBIGUOUS')`;
/** Live nodes only, as in graph.ts (ARCHIVED = soft-deleted declarations of renamed/edited/removed files). */
const LIVE_N = "n.approval_status <> 'ARCHIVED'";

export type ReportResult =
  | { readonly kind: "ok"; readonly report: RepoReport }
  | { readonly kind: "none" }
  | { readonly kind: "busy" };

interface CacheEntry {
  readonly key: string;
  readonly report: RepoReport;
}
const reportCache = new Map<number, CacheEntry>();
export function resetReportCacheForTests(): void {
  reportCache.clear();
}

/** Lines of the git history the loader may mine: bounded in count and time. */
const HISTORY_COMMITS = 1500;

function gitHistory(root: string): ReportHistoryRow[] | null {
  let out: string;
  try {
    out = execFileSync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-C",
        root,
        "log",
        `-n`,
        String(HISTORY_COMMITS),
        "--no-merges",
        "--name-only",
        "--format=%x00",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 4000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      },
    );
  } catch {
    return null;
  }
  const commits: string[][] = [];
  for (const chunk of out.split("\0")) {
    const files = chunk.split("\n").filter(Boolean);
    if (files.length > 0 && files.length <= 60) commits.push(files); // a 400-file reformat says nothing about coupling
  }
  if (commits.length === 0) return null;
  const count = new Map<string, number>();
  for (const files of commits) for (const f of files) count.set(f, (count.get(f) ?? 0) + 1);
  const top = [...count]
    .filter(([f]) => classifyPath(f) === "source")
    .sort((x, y) => y[1] - x[1] || cmp(x[0], y[0]))
    .slice(0, 20);
  const topSet = new Set(top.map((t) => t[0]));
  const together = new Map<string, Map<string, number>>();
  for (const files of commits) {
    for (const a of files) {
      if (!topSet.has(a)) continue;
      const m = together.get(a) ?? new Map<string, number>();
      for (const b of files)
        if (b !== a && classifyPath(b) === "source") m.set(b, (m.get(b) ?? 0) + 1);
      together.set(a, m);
    }
  }
  return top.map(([file, n]) => ({
    file,
    commits: n,
    changesWith: [...(together.get(file) ?? [])]
      .filter(([, c]) => c >= 2)
      .sort((x, y) => y[1] - x[1] || cmp(x[0], y[0]))
      .slice(0, 3)
      .map((x) => x[0]),
  }));
}

function commitsBehind(root: string, sha: string | null): number | null {
  if (!sha) return null;
  try {
    const n = Number.parseInt(
      execFileSync(
        "git",
        ["-c", "core.fsmonitor=false", "-C", root, "rev-list", "--count", `${sha}..HEAD`],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        },
      ).trim(),
      10,
    );
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * The report for the repo a `cwd` belongs to, or null when it has no whole index. Read-only; throws StoreMaintenanceError
 * (the reader answers busy) and falls back to null on any other read failure, like buildGraphSnapshot.
 */
export function buildRepoReportForCwd(
  cwd: string,
  now: () => Date = () => new Date(),
): RepoReport | null {
  return reportSafeRead(() => loadAndBuild(cwd, now), null);
}

function loadAndBuild(cwd: string, now: () => Date): RepoReport | null {
  const database = openGraphStore();
  const match = resolveRepoForCwd(database, cwd);
  if (match === null) return null;
  if (indexDiedPartWay(database, [match.full_path, cwd])) return null;
  const top = database
    .prepare(
      `SELECT b.id AS id, b.branch_name AS branch, b.last_commit_sha AS sha,
         (SELECT COUNT(*) FROM nodes n WHERE n.repository_branch_id = b.id AND ${LIVE_N}) AS nodes
       FROM repository_branches b WHERE b.repository_id = ? ORDER BY nodes DESC LIMIT 1`,
    )
    .get(match.id) as { id: number; branch: string; sha: string | null; nodes: number } | undefined;
  if (!top || top.nodes === 0) return null;
  const branchId = top.id;

  // Cache key: the branch's newest completed index (active generation + newest file index time) and where HEAD is. A
  // re-index or a freshness catch-up changes it; opening the panel twice does not.
  const gen = database
    .prepare(
      `SELECT (SELECT MAX(id) FROM ingest_generations g WHERE g.repository_branch_id = ? AND g.status = 'ACTIVE') AS gen,
              (SELECT MAX(last_indexed_at) FROM files f WHERE f.repository_branch_id = ?) AS indexed,
              ? AS nodes`,
    )
    .get(branchId, branchId, top.nodes) as {
    gen: number | null;
    indexed: string | null;
    nodes: number;
  };
  const onDisk = fs.existsSync(match.full_path);
  const headSha = onDisk ? readHeadSha(match.full_path) : null;
  const indexedSha = top.sha ?? null;
  const key = `${gen.gen ?? 0}|${gen.indexed ?? ""}|${gen.nodes}|${indexedSha ?? ""}|${headSha ?? ""}`;
  const hit = reportCache.get(branchId);
  if (hit && hit.key === key) return hit.report;

  const files = (
    database
      .prepare(
        `SELECT path FROM files WHERE repository_branch_id = ? AND index_status != 'REMOVED'`,
      )
      .all(branchId) as Array<{ path: string }>
  ).map((r) => r.path);
  const pathById = new Map<number, string>();
  for (const r of database
    .prepare(`SELECT id, path FROM files WHERE repository_branch_id = ?`)
    .all(branchId) as Array<{ id: number; path: string }>)
    pathById.set(r.id, r.path);

  const nodes: ReportNode[] = [];
  for (const r of database
    .prepare(
      `SELECT n.id, n.node_type AS kind, n.name, n.file_id AS fileId, n.start_line AS line, n.end_line AS endLine
       FROM nodes n WHERE n.repository_branch_id = ? AND ${LIVE_N} AND n.node_type IN (${sqlList(NODE_KINDS)})`,
    )
    .all(branchId) as Array<{
    id: number;
    kind: string;
    name: string;
    fileId: number | null;
    line: number | null;
    endLine: number | null;
  }>)
    nodes.push({
      id: r.id,
      kind: r.kind,
      name: r.name,
      file: r.fileId === null ? "" : (pathById.get(r.fileId) ?? ""),
      line: r.line,
      endLine: r.endLine,
    });

  // Driven from the branch's nodes (idx_edges_from_node); `+nt` keeps the planner off a scan of every repo's nodes.
  const pairs = (
    database
      .prepare(
        `SELECT e.from_node_id AS "from", e.to_node_id AS "to",
           SUM(CASE WHEN ${WEAK} THEN 0 ELSE 1 END) AS resolved,
           SUM(CASE WHEN ${WEAK} THEN 1 ELSE 0 END) AS heuristic,
           SUM(CASE WHEN e.edge_type = 'CALLS' AND NOT (${WEAK}) THEN 1 ELSE 0 END) AS calls,
           SUM(CASE WHEN e.edge_type = 'IMPORTS' THEN 1 ELSE 0 END) AS imports
         FROM nodes nf
         CROSS JOIN edges e ON e.from_node_id = nf.id
         CROSS JOIN nodes nt ON nt.id = e.to_node_id
         WHERE nf.repository_branch_id = ? AND +nt.repository_branch_id = ?
           AND nf.approval_status <> 'ARCHIVED' AND nt.approval_status <> 'ARCHIVED'
           AND e.edge_type IN (${sqlList([...DEP_EDGES, "HEURISTIC_CALLS"])})
           AND e.from_node_id <> e.to_node_id
         GROUP BY e.from_node_id, e.to_node_id`,
      )
      .all(branchId, branchId) as unknown as ReportPair[]
  ).map((r) => ({
    from: Number(r.from),
    to: Number(r.to),
    resolved: Number(r.resolved),
    heuristic: Number(r.heuristic),
    calls: Number(r.calls),
    imports: Number(r.imports),
  }));

  const docs = (
    database
      .prepare(
        `SELECT n.file_id AS fileId, n.start_line AS line, SUBSTR(COALESCE(n.summary, n.name), 1, 400) AS text
         FROM nodes n WHERE n.repository_branch_id = ? AND ${LIVE_N} AND n.node_type = 'RATIONALE'
           AND n.start_line IS NOT NULL AND json_extract(n.properties, '$.kind') = 'docstring'`,
      )
      .all(branchId) as Array<{ fileId: number | null; line: number; text: string }>
  )
    .filter((r) => r.fileId !== null && pathById.has(r.fileId))
    .map((r) => ({ file: pathById.get(r.fileId!)!, line: r.line, text: r.text }));

  const noteRows = (
    database
      .prepare(
        `SELECT n.node_type AS kind, n.file_id AS fileId, n.start_line AS line, SUBSTR(COALESCE(n.summary, n.name), 1, 4000) AS text
         FROM nodes n WHERE n.repository_branch_id = ? AND ${LIVE_N} AND n.node_type IN ('RATIONALE', 'DOC')
           AND (n.summary GLOB '*TODO*' OR n.summary GLOB '*FIXME*' OR n.summary GLOB '*HACK*' OR n.summary GLOB '*WARNING*'
             OR n.summary GLOB '*NOTE*' OR n.summary GLOB '*WHY*')`,
      )
      .all(branchId) as Array<{
      kind: string;
      fileId: number | null;
      line: number | null;
      text: string;
    }>
  )
    .filter((r) => r.fileId !== null && pathById.has(r.fileId))
    .map((r) => ({ kind: r.kind, file: pathById.get(r.fileId!)!, line: r.line, text: r.text }));

  let history: ReportHistoryRow[] | null = null;
  if (onDisk) history = gitHistory(match.full_path);
  const stale = !!(
    indexedSha &&
    headSha &&
    !headSha.startsWith(indexedSha) &&
    !indexedSha.startsWith(headSha)
  );
  const docStmt = database.prepare(
    `SELECT json_extract(properties, '$.docstring') AS doc FROM nodes WHERE id = ?`,
  );
  const report = buildRepoReport({
    docText: (id) => {
      const row = docStmt.get(id) as { doc: unknown } | undefined;
      return typeof row?.doc === "string" && row.doc ? row.doc.slice(0, 600) : null;
    },
    repo: match.name,
    branch: top.branch,
    indexedSha,
    stale,
    behindCommits: stale && onDisk ? commitsBehind(match.full_path, indexedSha) : null,
    generatedAt: now().toISOString(),
    files,
    nodes,
    pairs,
    docs,
    noteRows,
    manifests: onDisk ? readManifests(match.full_path) : [],
    history,
    repoOnDisk: onDisk,
  });
  reportCache.set(branchId, { key, report });
  if (reportCache.size > 8) reportCache.delete(reportCache.keys().next().value as number);
  return report;
}

export type { GraphDb };
