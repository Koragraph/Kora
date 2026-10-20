/**
 * Pure view-model rules behind the Overview tab: which sections show, in what order, how a question is routed, how an area
 * is found and toned. No React, so every rule is tested without a DOM.
 */
import type { RepoArea, RepoQuestion, RepoReport, RepoSymbolRef } from "@kora/shared/repoReport";

export type OverviewSectionId =
  | "areas"
  | "hubs"
  | "entryPoints"
  | "bridges"
  | "hotspots"
  | "cycles"
  | "notes"
  | "questions";

export const OVERVIEW_SECTION_TITLES: Readonly<Record<OverviewSectionId, string>> = {
  areas: "Areas",
  hubs: "Most depended on",
  entryPoints: "Where execution starts",
  bridges: "Connections between areas",
  hotspots: "What changes most",
  cycles: "Import cycles",
  notes: "Notes left in the code",
  questions: "Ask the graph",
};

/** The sections to render, in the spec's order; an empty one is left out, not shown empty. */
export function visibleSections(report: RepoReport): OverviewSectionId[] {
  const counts: Record<OverviewSectionId, number> = {
    areas: report.areas.length,
    hubs: report.hubs.length,
    entryPoints: report.entryPoints.length,
    bridges: report.bridges.length,
    hotspots: report.hotspots.length,
    cycles: report.cycles.length,
    notes: report.notes.length,
    questions: report.questions.length,
  };
  return (Object.keys(OVERVIEW_SECTION_TITLES) as OverviewSectionId[]).filter(
    (id) => counts[id] > 0,
  );
}

/** Areas biggest first (the contract says so; this keeps a hand-built report honest), ties by name. */
export function sortedAreas(report: RepoReport): RepoArea[] {
  return [...report.areas].sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
}

export function sortedHubs(report: RepoReport): RepoReport["hubs"][number][] {
  return [...report.hubs].sort(
    (a, b) => b.dependents - a.dependents || a.name.localeCompare(b.name),
  );
}

export function sortedHotspots(report: RepoReport): RepoReport["hotspots"][number][] {
  return [...report.hotspots].sort((a, b) => b.commits - a.commits || a.file.localeCompare(b.file));
}

export function sortedBridges(report: RepoReport): RepoReport["bridges"][number][] {
  return [...report.bridges].sort((a, b) => b.edges - a.edges);
}

export function areaIndex(report: RepoReport): ReadonlyMap<string, RepoArea> {
  return new Map(report.areas.map((a) => [a.id, a] as const));
}

/** An area's name; an unknown id (a link past the area cap) shows as the id rather than vanishing. */
export function areaNameOf(report: RepoReport, id: string | null): string {
  if (id === null) return "";
  return areaIndex(report).get(id)?.name ?? id;
}

// ---- questions ----

export type QuestionRoute = "quick-answer" | "composer";

/** callers / where / impact are answered from the graph with no agent turn when a thread is open; the rest wait in the composer. */
export function routeQuestion(q: RepoQuestion, hasActiveThread: boolean): QuestionRoute {
  return q.kind !== "explore" && hasActiveThread ? "quick-answer" : "composer";
}

// ---- paths and symbols ----

/** `a/b/…/file.ts`, keeping the first segment and as much of the tail as fits; never cuts the file name short first. */
export function middleTruncate(path: string, max = 44): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  if (parts.length < 3) return `${path.slice(0, Math.max(1, max - 1))}…`;
  const head = parts[0]!;
  let tail = parts[parts.length - 1]!;
  for (let i = parts.length - 2; i >= 1; i--) {
    const next = `${parts[i]}/${tail}`;
    if (head.length + 2 + next.length > max) break;
    tail = next;
  }
  const out = `${head}/…/${tail}`;
  return out.length <= max ? out : `…${tail.slice(-(max - 1))}`;
}

/** React key for a bridge example: names alone collide (two `response` declarations in different files). */
export function bridgeExampleKey(x: {
  from: Pick<RepoSymbolRef, "name" | "file" | "line">;
  to: Pick<RepoSymbolRef, "name" | "file" | "line">;
}): string {
  return `${x.from.name}@${locationOf(x.from)}>${x.to.name}@${locationOf(x.to)}`;
}

export function locationOf(ref: Pick<RepoSymbolRef, "file" | "line">): string {
  return ref.line ? `${ref.file}:${ref.line}` : ref.file;
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export const REPORT_FILENAME = "GRAPH_REPORT.md";

// ---- graph tab colouring ----

/** Five greys, brightest first (no hue): the area rank picks one, so neighbours in the legend tend to differ. */
const TONES = [1, 0.7, 0.42, 0.86, 0.2] as const;

/** Grey level (0-255) for a tone; the canvas and the legend swatch share it so they always agree. */
export const toneToGrey = (tone: number): number => 70 + Math.round(185 * tone);

export interface AreaLegendEntry {
  readonly id: string;
  readonly name: string;
  readonly files: number;
  readonly tone: number;
}

export function areaLegend(report: RepoReport): AreaLegendEntry[] {
  return sortedAreas(report).map((a, i) => ({
    id: a.id,
    name: a.name,
    files: a.files,
    tone: TONES[i % TONES.length]!,
  }));
}

/** file -> tone for the nodes of a snapshot; null for a file the report does not place (it keeps the degree shade). */
export function toneForFile(
  report: RepoReport | null,
  legend: ReadonlyArray<AreaLegendEntry>,
  file: string,
): number | null {
  if (!report) return null;
  const id = report.fileAreas[file];
  if (!id) return null;
  return legend.find((e) => e.id === id)?.tone ?? null;
}

/** Ids of the snapshot nodes whose file belongs to an area, to light just that area. */
export function nodeIdsInArea(
  report: RepoReport,
  areaId: string,
  nodes: ReadonlyArray<{ readonly id: number; readonly file: string }>,
): Set<number> {
  const ids = new Set<number>();
  for (const n of nodes) if (report.fileAreas[n.file] === areaId) ids.add(n.id);
  return ids;
}

/** The old directory-cluster legend is the fallback when the report did not place enough of the shown nodes. */
export function areaColouringUsable(
  report: RepoReport | null,
  nodes: ReadonlyArray<{ readonly file: string }>,
): boolean {
  if (!report || report.areas.length === 0 || nodes.length === 0) return false;
  let placed = 0;
  for (const n of nodes) if (report.fileAreas[n.file]) placed++;
  return placed / nodes.length >= 0.3;
}
