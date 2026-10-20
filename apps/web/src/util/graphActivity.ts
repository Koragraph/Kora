/**
 * Koragraph activity helpers.
 *
 * Our daemon emits a handful of custom chat activity kinds that carry
 * rich payloads (graph views, blast radius). These flow through the
 * normal work-log pipeline; the helpers here classify those kinds and parse their
 * payloads so the timeline can render a bespoke row instead of a plain summary
 * line. (There is deliberately no dollar-"savings" row — see GraphActivityRow.)
 */

/** Custom activity kinds our daemon sets for graph-usage telemetry. */
const GRAPH_ACTIVITY_KINDS = ["graph_query", "graph_result", "blast_radius"] as const;

export type GraphActivityKind = (typeof GRAPH_ACTIVITY_KINDS)[number];

const GRAPH_ACTIVITY_KIND_SET = new Set<string>(GRAPH_ACTIVITY_KINDS);

export function isGraphActivityKind(variant: string | undefined): variant is GraphActivityKind {
  return variant !== undefined && GRAPH_ACTIVITY_KIND_SET.has(variant);
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return val && typeof val === "object" ? (val as Record<string, unknown>) : null;
}

function asFiniteNumber(val: unknown): number {
  return typeof val === "number" && Number.isFinite(val) ? val : 0;
}

function asTrimmedString(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const stripped = val.trim();
  return stripped.length > 0 ? stripped : null;
}

export interface GraphQueryFields {
  op: string | null;
  subject: string | null;
}

export function parseGraphQuery(raw: unknown): GraphQueryFields {
  const fields = asRecord(raw);
  return {
    op: asTrimmedString(fields?.op),
    subject: asTrimmedString(fields?.subject),
  };
}

export function parseBlastRadiusSubject(raw: unknown): string | null {
  return asTrimmedString(asRecord(raw)?.subject);
}

export interface GraphViewNode {
  id: string;
  x: number;
  y: number;
  label: string | null;
}

export interface GraphViewEdge {
  from: string;
  to: string;
}

export interface GraphViewShape {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  focusId: string | null;
}

/**
 * Best-effort parse of the render-ready GraphView payload the daemon ships
 * (the same shape the inline graph cards consume). Defensive: unknown fields are
 * ignored, and anything malformed yields null so the row falls back gracefully.
 */
export function parseGraphView(raw: unknown): GraphViewShape | null {
  const surfaceView = asRecord(asRecord(raw)?.view) ?? asRecord(raw);
  if (!surfaceView) return null;
  const rawNodes = Array.isArray(surfaceView.nodes) ? surfaceView.nodes : [];
  const nodes: GraphViewNode[] = [];
  for (const unparsed of rawNodes) {
    const rawNode = asRecord(unparsed);
    if (!rawNode) continue;
    const nodeId = asTrimmedString(rawNode.id);
    if (!nodeId) continue;
    nodes.push({
      id: nodeId,
      x: Math.min(1, Math.max(0, asFiniteNumber(rawNode.x))),
      y: Math.min(1, Math.max(0, asFiniteNumber(rawNode.y))),
      label: asTrimmedString(rawNode.label) ?? asTrimmedString(rawNode.name),
    });
  }
  if (nodes.length === 0) return null;
  const nodeIds = new Set(nodes.map((node) => node.id));
  const rawEdges = Array.isArray(surfaceView.edges) ? surfaceView.edges : [];
  const edges: GraphViewEdge[] = [];
  for (const unparsed of rawEdges) {
    const edge = asRecord(unparsed);
    if (!edge) continue;
    const source = asTrimmedString(edge.from) ?? asTrimmedString(edge.source);
    const destination = asTrimmedString(edge.to) ?? asTrimmedString(edge.target);
    if (!source || !destination || !nodeIds.has(source) || !nodeIds.has(destination)) continue;
    edges.push({ from: source, to: destination });
  }
  return { nodes, edges, focusId: asTrimmedString(surfaceView.focusId) };
}
