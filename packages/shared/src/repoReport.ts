/**
 * The repo orientation report: "what is this codebase", built from the code graph alone (no model call, nothing leaves the
 * machine). The daemon's graph reader computes it (packages/ui-server/src/repoReport.ts), `GET /api/graph/report` serves it
 * (JSON, or `?format=md` for the Markdown below), the Graph Explorer shows it as its Overview tab, and the user can save it
 * as GRAPH_REPORT.md. It answers what users install Graphify for (the hubs, the areas, how they connect, where to start)
 * with only what the graph actually holds: every count is countable in the store, and `caveats` says what was left out.
 *
 * Contract: docs/graph/REPO-REPORT.md. Bump REPO_REPORT_VERSION on any breaking change to these shapes.
 */

export const REPO_REPORT_VERSION = 1 as const;

/** A declaration (or file) in the repo. */
export interface RepoSymbolRef {
  readonly name: string;
  /** The graph's node_type: METHOD, CLASS, INTERFACE, TYPE, CONSTANT, FIELD, FILE, ENDPOINT, ... */
  readonly kind: string;
  /** Repo-relative path. */
  readonly file: string;
  /** 1-based line of the declaration; null when the graph has none (a FILE row). */
  readonly line: number | null;
}

/** A declaration much of the code depends on (Graphify's "god nodes"). Tests, fixtures, benches and generated code never count. */
export interface RepoHub extends RepoSymbolRef {
  /** Distinct declarations that depend on it (call / import / extends edges, resolved and heuristic). */
  readonly dependents: number;
  /** Distinct files those dependents live in. */
  readonly dependentFiles: number;
  /** Areas other than its own that reach it. */
  readonly areasReached: number;
  /** Share of its dependents that rest only on heuristic (name-matched, unresolved) call edges, 0..1. */
  readonly heuristicShare: number;
  /** First sentence of its docstring (<= 160 chars), when the graph kept one. */
  readonly doc: string | null;
  readonly areaId: string | null;
}

export type RepoEntryPointWhy =
  /** package.json `bin`, pyproject `[project.scripts]`, Cargo `[[bin]]` */
  | "package-bin"
  /** package.json `main` / `exports` root, a library's public entry */
  | "package-main"
  /** `func main`, `if __name__ == "__main__"`, `fn main`, a `main()` in a main/cli/server file */
  | "main-function"
  /** an HTTP route handler the graph extracted (ENDPOINT plane) */
  | "route"
  /** a CLI command registration the graph can see */
  | "cli-command"
  /** a non-test declaration nothing in the repo calls that itself calls a lot (a likely top of a call chain) */
  | "root";

/** Where execution starts. */
export interface RepoEntryPoint extends RepoSymbolRef {
  readonly why: RepoEntryPointWhy;
  /** The bin name, "GET /users", ... */
  readonly detail: string | null;
  readonly areaId: string | null;
}

export interface RepoAreaLink {
  readonly areaId: string;
  /** Dependencies (declaration to declaration) from one area into the other. */
  readonly edges: number;
}

/** A group of files that mostly depend on each other: a community of the file dependency graph, named by its directories. */
export interface RepoArea {
  /** Stable slug, unique in the report ("services-resolution"). */
  readonly id: string;
  /** Human name from the directory most of its files share ("services/resolution", "cli"); unique in the report. */
  readonly name: string;
  /** The directories its files live in, most files first (<= 4). */
  readonly dirs: ReadonlyArray<string>;
  readonly files: number;
  readonly declarations: number;
  /** Test files that exercise this area (TESTS edges, test files importing it, naming). */
  readonly testFiles: number;
  /** <= 5, most depended-on first. */
  readonly keyFiles: ReadonlyArray<{ readonly file: string; readonly dependents: number }>;
  /** <= 5 most depended-on declarations inside it. */
  readonly keySymbols: ReadonlyArray<
    RepoSymbolRef & { readonly dependents: number; readonly doc: string | null }
  >;
  /** Areas this one depends on, most edges first (<= 5). */
  readonly uses: ReadonlyArray<RepoAreaLink>;
  /** Areas that depend on this one, most edges first (<= 5). */
  readonly usedBy: ReadonlyArray<RepoAreaLink>;
  /** One deterministic sentence: "38 files, 410 declarations. Starts at bin/cli.js. Most used: parseArgs (31 dependents)." */
  readonly summary: string;
}

/** A dependency between two areas worth knowing about (Graphify's "surprising connections"). */
export interface RepoBridge {
  /** Area ids, `from` depends on `to`. */
  readonly from: string;
  readonly to: string;
  readonly edges: number;
  /**
   * strongest: among the heaviest cross-area dependencies.
   * unexpected: two areas that otherwise barely touch (few edges either way, far apart in the tree).
   * single-point: almost all of the dependency goes through one declaration (a narrow waist; changing it touches both).
   */
  readonly why: "strongest" | "unexpected" | "single-point";
  /** <= 3 example dependencies across it. */
  readonly examples: ReadonlyArray<{ readonly from: RepoSymbolRef; readonly to: RepoSymbolRef }>;
}

/** A file that changes often, from the git history the graph mined. */
export interface RepoHotspot {
  readonly file: string;
  /** Commits that touched it in the mined history. */
  readonly commits: number;
  /** Files it most often changes together with (<= 3). */
  readonly changesWith: ReadonlyArray<string>;
}

/** A comment the graph kept that explains why (NOTE / WHY / HACK / FIXME / TODO / WARNING markers). */
export interface RepoNote extends RepoSymbolRef {
  readonly tag: string;
  /** <= 200 chars. */
  readonly text: string;
}

/** callers / where / impact are answered from the graph with no agent turn (graph/quick-answer.ts); explore goes to the agent. */
export type RepoQuestionKind = "callers" | "where" | "impact" | "explore";

/** A question the graph can answer, ready to send ("who calls parseArgs?"). */
export interface RepoQuestion {
  readonly text: string;
  readonly kind: RepoQuestionKind;
  /** The symbol or file it is about. */
  readonly target: string;
}

export interface RepoReport {
  readonly version: typeof REPO_REPORT_VERSION;
  readonly repo: string;
  readonly branch: string;
  /** Commit the index was built at. */
  readonly indexedSha: string | null;
  /** HEAD has moved since the index was built (the report may miss recent changes). */
  readonly stale: boolean;
  /** ISO time the report was computed. */
  readonly generatedAt: string;
  readonly stats: {
    /** Files in the report (tests counted separately, fixtures / generated / vendored left out). */
    readonly files: number;
    readonly declarations: number;
    /** Dependency edges between declarations (calls, imports, extends, ...), not containment. */
    readonly edges: number;
    readonly testFiles: number;
    /** Share of call edges that are heuristic (name-matched, unresolved), 0..1. */
    readonly heuristicEdgeShare: number;
    readonly languages: ReadonlyArray<{ readonly language: string; readonly files: number }>;
  };
  /** Most files first. Typically 3-12; a tiny repo can have one. */
  readonly areas: ReadonlyArray<RepoArea>;
  /** <= 15, most dependents first. */
  readonly hubs: ReadonlyArray<RepoHub>;
  /** <= 15. */
  readonly entryPoints: ReadonlyArray<RepoEntryPoint>;
  /** <= 8. */
  readonly bridges: ReadonlyArray<RepoBridge>;
  /** <= 10; empty when the graph has no git history. */
  readonly hotspots: ReadonlyArray<RepoHotspot>;
  /** Import cycles as file paths, <= 5. Each lists a file once; the cycle closes back from the last to the first. */
  readonly cycles: ReadonlyArray<ReadonlyArray<string>>;
  /** <= 10. */
  readonly notes: ReadonlyArray<RepoNote>;
  /** 4-8 questions about this repo's own hubs, entry points and areas. */
  readonly questions: ReadonlyArray<RepoQuestion>;
  /** File -> area id, for colouring the graph view (<= 5000 entries; files past that are absent). */
  readonly fileAreas: Readonly<Record<string, string>>;
  /** Plain sentences about what the report leaves out or cannot know ("The index is 3 commits behind HEAD."). */
  readonly caveats: ReadonlyArray<string>;
}

const loc = (s: RepoSymbolRef): string => (s.line ? `${s.file}:${s.line}` : s.file);
const ENTRY_WHY: Record<RepoEntryPointWhy, string> = {
  "package-bin": "package bin",
  "package-main": "package entry",
  "main-function": "main function",
  route: "route",
  "cli-command": "CLI command",
  root: "top of a call chain",
};
const BRIDGE_WHY: Record<RepoBridge["why"], string> = {
  strongest: "heaviest",
  "single-point": "nearly all through one declaration",
  unexpected: "unexpected, these areas otherwise barely touch",
};
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const pct = (x: number): string => `${Math.round(x * 100)}%`;
/** A Markdown table cell: no pipes or newlines. */
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

/**
 * The report as GRAPH_REPORT.md: plain Markdown a person can read, commit, or paste into an agent's context. Deterministic
 * (same report, same text) and free of anything machine-specific (no absolute paths, no timestamps but the one header line).
 */
export function renderRepoReportMarkdown(r: RepoReport): string {
  const areaName = new Map(r.areas.map((a) => [a.id, a.name] as const));
  const nameOf = (id: string | null): string => (id ? (areaName.get(id) ?? id) : "-");
  const out: string[] = [];
  const s = r.stats;
  out.push(`# ${r.repo}: code map`);
  out.push("");
  out.push(
    `Branch \`${r.branch}\`${r.indexedSha ? `, indexed at \`${r.indexedSha.slice(0, 10)}\`` : ""}${r.stale ? " (HEAD has moved since)" : ""}. ` +
      `${plural(s.files, "file")}, ${plural(s.declarations, "declaration")}, ${plural(s.edges, "dependency", "dependencies")}, ${plural(s.testFiles, "test file")}. ` +
      `Built by Kora from its code graph on ${r.generatedAt.slice(0, 10)}.`,
  );
  if (s.languages.length)
    out.push("", `Languages: ${s.languages.map((l) => `${l.language} (${l.files})`).join(", ")}.`);

  if (r.areas.length) {
    out.push("", "## Areas", "");
    for (const a of r.areas) {
      out.push(`### ${a.name}`, "", a.summary, "");
      if (a.keyFiles.length)
        out.push(`- Key files: ${a.keyFiles.map((f) => `\`${f.file}\``).join(", ")}`);
      if (a.keySymbols.length)
        out.push(
          `- Most used: ${a.keySymbols.map((k) => `\`${k.name}\` (${k.dependents})`).join(", ")}`,
        );
      if (a.uses.length)
        out.push(`- Uses: ${a.uses.map((l) => `${nameOf(l.areaId)} (${l.edges})`).join(", ")}`);
      if (a.usedBy.length)
        out.push(
          `- Used by: ${a.usedBy.map((l) => `${nameOf(l.areaId)} (${l.edges})`).join(", ")}`,
        );
      if (a.testFiles) out.push(`- Tests: ${plural(a.testFiles, "file")}`);
      out.push("");
    }
  }

  if (r.hubs.length) {
    out.push("## What most of the code depends on", "");
    out.push(
      "| Declaration | Where | Dependents | Areas reaching it | Note |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const h of r.hubs) {
      const note = [
        h.doc ?? "",
        h.heuristicShare >= 0.5 ? `${pct(h.heuristicShare)} of its callers are name-matched` : "",
      ]
        .filter(Boolean)
        .join(" ");
      out.push(
        `| \`${cell(h.name)}\` | \`${cell(loc(h))}\` | ${h.dependents} in ${plural(h.dependentFiles, "file")} | ${h.areasReached} | ${cell(note)} |`,
      );
    }
    out.push("");
  }

  if (r.entryPoints.length) {
    out.push("## Where execution starts", "");
    for (const e of r.entryPoints)
      out.push(
        `- \`${e.name}\` at \`${loc(e)}\`: ${ENTRY_WHY[e.why]}${e.detail ? ` (${e.detail})` : ""}${e.areaId ? `, in ${nameOf(e.areaId)}` : ""}`,
      );
    out.push("");
  }

  if (r.bridges.length) {
    out.push("## Connections between areas", "");
    for (const b of r.bridges) {
      const ex = b.examples.map((x) => `\`${x.from.name}\` -> \`${x.to.name}\``).join(", ");
      out.push(
        `- ${nameOf(b.from)} -> ${nameOf(b.to)}: ${plural(b.edges, "dependency", "dependencies")}, ${BRIDGE_WHY[b.why]}${ex ? `, e.g. ${ex}` : ""}`,
      );
    }
    out.push("");
  }

  if (r.hotspots.length) {
    out.push("## What changes most (git history)", "");
    for (const h of r.hotspots)
      out.push(
        `- \`${h.file}\`: ${h.commits} commits${h.changesWith.length ? `, changes with ${h.changesWith.map((f) => `\`${f}\``).join(", ")}` : ""}`,
      );
    out.push("");
  }

  if (r.cycles.length) {
    out.push("## Import cycles", "");
    // Each cycle lists a file once; it closes back to the first.
    for (const c of r.cycles)
      out.push(`- ${[...c, ...(c.length ? [c[0]!] : [])].map((f) => `\`${f}\``).join(" -> ")}`);
    out.push("");
  }

  if (r.notes.length) {
    out.push("## Notes left in the code", "");
    for (const n of r.notes) out.push(`- ${n.tag} at \`${loc(n)}\`: ${n.text}`);
    out.push("");
  }

  if (r.questions.length) {
    out.push("## Questions the graph can answer", "");
    for (const q of r.questions) out.push(`- ${q.text}`);
    out.push("");
  }

  if (r.caveats.length) {
    out.push("## Limits of this map", "");
    for (const c of r.caveats) out.push(`- ${c}`);
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}
