// The koragraph → graph.* interceptor.
//
// koragraph tool calls are intercepted (like kora_spawn) so a query that returns a real
// neighborhood renders as a §02 GraphCard instead of an opaque tool.result blob. The daemon holds
// the resolved graph, so it computes the LAYOUT ONCE (normalized 0..1 positions) and ships it; the
// renderer only draws SVG (no graph-layout lib). Everything here is PURE and deterministic — no I/O,
// no clock — so it is exhaustively unit-tested.
//
// Promotion (§06 §3 / 06-Q4): only explore / blast_radius / neighbours / changes_with with a real
// neighborhood (>= MIN_GRAPH_NODES nodes) promote to a graph. search_code / file_symbols / overview
// stay plain text tool cards.
import type {
  GraphOp, GraphView, GraphNode, GraphEdge, UnsequencedChatEvent, ItemId,
} from './events';

/** koragraph tool result shape (GraphService.callTool → { text, data, ms }). `data` is opaque. */
export interface GraphToolResult { text: string; data: unknown; ms?: number }

/** Node/edge count bounds for card-vs-graph (06-Q4: ~4–40 nodes → graph). */
export const MIN_GRAPH_NODES = 4;
export const MAX_GRAPH_NODES = 40;

const GRAPH_PROMOTABLE: ReadonlySet<string> = new Set(['explore', 'blast_radius', 'neighbours', 'changes_with']);
const ALL_GRAPH_OPS: ReadonlySet<string> = new Set(['explore', 'blast_radius', 'neighbours', 'search_code', 'changes_with', 'overview']);

/** Map a koragraph tool name to a GraphOp, or null if it is not a graph op (e.g. file_symbols). */
export function classifyGraphOp(toolName: string): GraphOp | null {
  const n = normalizeToolName(toolName);
  return ALL_GRAPH_OPS.has(n) ? (n as GraphOp) : null;
}

/** Strip an MCP prefix ("kora_explore", "mcp__kora__explore") down to the bare tool name. */
export function normalizeToolName(toolName: string): string {
  return String(toolName).replace(/^mcp__[^_]+__/, '').replace(/^kora[_-]/, '').trim();
}

// ── neighborhood extraction ─────────────────────────────────────────────────────
type NodeKind = GraphNode['kind'];
type EdgeKind = GraphEdge['kind'];

interface RawNode { id: string; label: string; kind: NodeKind; file: string; line?: number; hazard?: boolean; rel: 'focus' | 'in' | 'out' | 'other' }
interface RawEdge { from: string; to: string; kind: EdgeKind }
export interface Neighborhood { focusId?: string; nodes: RawNode[]; edges: RawEdge[] }

function kindOf(type: unknown): NodeKind {
  const t = String(type ?? '').toUpperCase();
  if (t.includes('METHOD')) return 'method';
  if (t.includes('CLASS') || t.includes('INTERFACE') || t.includes('STRUCT') || t.includes('ENUM')) return 'class';
  if (t.includes('CONST') || t.includes('VAR') || t.includes('FIELD') || t.includes('PROP')) return 'const';
  if (t.includes('FILE')) return 'file';
  if (t.includes('MODULE') || t.includes('PACKAGE') || t.includes('NAMESPACE')) return 'module';
  return 'fn';
}

function edgeKindOf(edgeType: unknown, op: GraphOp): EdgeKind {
  const t = String(edgeType ?? '').toUpperCase();
  if (op === 'changes_with') return 'cochange';
  if (t.includes('IMPORT') || t.includes('CONTAINS')) return 'imports';
  if (t.includes('COCHANGE') || t.includes('CHANGE')) return 'cochange';
  if (t.includes('CONTRACT')) return 'contract';
  return 'calls';
}

const nodeId = (name: unknown, file: unknown, line?: unknown): string =>
  `${String(name ?? '?')}@${String(file ?? '')}${line != null ? ':' + line : ''}`;

/**
 * Turn a koragraph result into a normalized neighborhood. Handles the structured `explore` shape
 * (focus[].callers/callees), a generic `{ nodes, edges }` shape, and a text fallback that parses
 * "name @ file:line" lines (mirroring cross-worktree.ts's parseDependents). Defensive throughout:
 * the graph is advisory (D19), so a shape it can't read yields an empty neighborhood, not a throw.
 */
export function extractNeighborhood(op: GraphOp, result: GraphToolResult): Neighborhood {
  const nodes = new Map<string, RawNode>();
  const edges: RawEdge[] = [];
  let focusId: string | undefined;

  const addNode = (n: Omit<RawNode, 'rel'> & { rel?: RawNode['rel'] }): string => {
    const id = n.id;
    const existing = nodes.get(id);
    if (existing) {
      if (n.rel === 'focus') existing.rel = 'focus';
      if (n.hazard) existing.hazard = true;
      return id;
    }
    nodes.set(id, { rel: 'other', ...n });
    return id;
  };

  const data: any = result?.data;
  const focusList: any[] = Array.isArray(data?.focus) ? data.focus : [];

  // 1) Structured `explore` shape: focus symbols with callers (in) / callees (out).
  for (const f of focusList) {
    const fid = nodeId(f.name, f.file, f.line);
    addNode({ id: fid, label: String(f.name ?? '?'), kind: kindOf(f.type), file: String(f.file ?? ''), line: numOr(f.line), hazard: !!f.hazard, rel: 'focus' });
    if (!focusId) focusId = fid;
    for (const c of arr(f.callers)) {
      const cid = addNode({ id: nodeId(c.name, c.file, c.line), label: String(c.name ?? '?'), kind: kindOf(c.type), file: String(c.file ?? ''), line: numOr(c.line), hazard: !!c.hazard, rel: 'in' });
      edges.push({ from: cid, to: fid, kind: edgeKindOf(c.edge_type, op) });
    }
    for (const c of arr(f.callees)) {
      const cid = addNode({ id: nodeId(c.name, c.file, c.line), label: String(c.name ?? '?'), kind: kindOf(c.type), file: String(c.file ?? ''), line: numOr(c.line), hazard: !!c.hazard, rel: 'out' });
      edges.push({ from: fid, to: cid, kind: edgeKindOf(c.edge_type, op) });
    }
  }
  for (const o of arr(data?.others)) {
    addNode({ id: nodeId(o.name, o.file, o.line), label: String(o.name ?? '?'), kind: kindOf(o.type), file: String(o.file ?? ''), line: numOr(o.line), rel: 'other' });
  }

  // 2) Generic `{ nodes, edges }` shape (blast_radius / neighbours variants that ship it directly).
  if (nodes.size === 0 && (Array.isArray(data?.nodes) || Array.isArray(data?.dependents) || Array.isArray(data?.callers))) {
    for (const n of arr(data?.nodes)) {
      const id = addNode({ id: nodeId(n.name ?? n.id ?? n.symbol, n.file, n.line), label: String(n.name ?? n.symbol ?? n.id ?? '?'), kind: kindOf(n.type ?? n.kind), file: String(n.file ?? ''), line: numOr(n.line), hazard: !!n.hazard, rel: n.focus ? 'focus' : 'other' });
      if (n.focus && !focusId) focusId = id;
    }
    for (const d of [...arr(data?.dependents), ...arr(data?.callers)]) {
      addNode({ id: nodeId(d.name ?? d.symbol, d.file, d.line), label: String(d.name ?? d.symbol ?? '?'), kind: kindOf(d.type), file: String(d.file ?? ''), line: numOr(d.line), hazard: !!d.hazard, rel: 'in' });
    }
    for (const e of arr(data?.edges)) {
      if (e && e.from != null && e.to != null) edges.push({ from: String(e.from), to: String(e.to), kind: edgeKindOf(e.kind ?? e.edge_type, op), });
    }
  }

  // 3) Text fallback: "❯ name @ path:line" / "  name @ path:line".
  if (nodes.size === 0 && typeof result?.text === 'string') {
    for (const raw of result.text.split('\n')) {
      const m = /^[\s│┃|❯›>■◦*-]*([A-Za-z_$][\w$.:#]*)\s+@\s+([^\s:]+):(\d+)/.exec(raw.trim());
      if (!m) continue;
      const id = nodeId(m[1], m[2], m[3]);
      const rel: RawNode['rel'] = nodes.size === 0 ? 'focus' : 'in';
      const added = addNode({ id, label: m[1], kind: 'fn', file: m[2], line: Number(m[3]), rel });
      if (rel === 'focus' && !focusId) focusId = added;
    }
  }

  return { focusId, nodes: [...nodes.values()], edges };
}

// ── layout (daemon-side, normalized 0..1) ─────────────────────────────────────
/**
 * Deterministic radial-ish layout: focus centered, incoming (callers) fanned on the left, outgoing
 * (callees) on the right, neutral nodes along the top. Positions are clamped to [0.06, 0.94] so
 * nothing clips the card edge. Pure and stable (same input → same output) for snapshot testing.
 */
export function layoutNeighborhood(nb: Neighborhood): GraphView {
  const capped = capNodes(nb);
  const ins = capped.nodes.filter((n) => n.rel === 'in');
  const outs = capped.nodes.filter((n) => n.rel === 'out');
  const others = capped.nodes.filter((n) => n.rel === 'other');
  const focus = capped.nodes.filter((n) => n.rel === 'focus');
  const seamSet = seamEdges(capped);

  const place = (list: RawNode[], x: number): Map<string, { x: number; y: number }> => {
    const m = new Map<string, { x: number; y: number }>();
    const n = list.length;
    list.forEach((node, i) => { m.set(node.id, { x, y: clamp(n === 1 ? 0.5 : 0.1 + (0.8 * i) / (n - 1)) }); });
    return m;
  };
  const pos = new Map<string, { x: number; y: number }>();
  for (const f of focus) pos.set(f.id, { x: 0.5, y: 0.5 });
  if (focus.length === 0 && capped.nodes.length) pos.set(capped.nodes[0].id, { x: 0.5, y: 0.5 }); // no explicit focus: center the first
  merge(pos, place(ins, 0.12));
  merge(pos, place(outs, 0.88));
  merge(pos, placeTop(others));

  const nodes: GraphNode[] = capped.nodes.map((n) => {
    const p = pos.get(n.id) ?? { x: 0.5, y: 0.5 };
    return { id: n.id, label: n.label, kind: n.kind, file: n.file, line: n.line, x: round(p.x), y: round(p.y), ...(n.hazard ? { hazard: true } : {}) };
  });
  const edges: GraphEdge[] = capped.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, ...(seamSet.has(edgeKey(e)) ? { crossesSeam: true } : {}) }));
  return { nodes, edges, ...(capped.focusId ? { focusId: capped.focusId } : {}) };
}

function placeTop(list: RawNode[]): Map<string, { x: number; y: number }> {
  const m = new Map<string, { x: number; y: number }>();
  const n = list.length;
  list.forEach((node, i) => { m.set(node.id, { x: clamp(n === 1 ? 0.5 : 0.15 + (0.7 * i) / (n - 1)), y: 0.08 }); });
  return m;
}

/** Cap to MAX_GRAPH_NODES, always keeping the focus + as many in/out as fit, dropping dangling edges. */
function capNodes(nb: Neighborhood): Neighborhood {
  if (nb.nodes.length <= MAX_GRAPH_NODES) return nb;
  const rank = (n: RawNode) => (n.rel === 'focus' ? 0 : n.rel === 'in' ? 1 : n.rel === 'out' ? 2 : 3);
  const kept = [...nb.nodes].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_GRAPH_NODES);
  const ids = new Set(kept.map((n) => n.id));
  return { focusId: nb.focusId, nodes: kept, edges: nb.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

/** Seam edges (§06 §4 / GraphCard): an edge whose endpoints live in different files. */
function seamEdges(nb: Neighborhood): Set<string> {
  const fileOf = new Map(nb.nodes.map((n) => [n.id, n.file]));
  const set = new Set<string>();
  for (const e of nb.edges) { const a = fileOf.get(e.from); const b = fileOf.get(e.to); if (a && b && a !== b) set.add(edgeKey(e)); }
  return set;
}

// ── the interceptor entry point ───────────────────────────────────────────────
export interface InterceptOutcome {
  /** graph.query / graph.result / context.blast-radius payloads (no seq/envelope yet). */
  events: UnsequencedChatEvent[];
  /** true when the call rendered as a graph surface — the caller then SKIPS the plain tool card. */
  promoted: boolean;
}

/**
 * Decide how a koragraph tool call renders. `itemId` ties graph.query↔graph.result to one card.
 *   - explore/blast_radius/neighbours/changes_with with >= MIN_GRAPH_NODES → graph.query + graph.result
 *     (+ context.blast-radius for blast_radius)
 *   - everything else / too-small → not promoted (caller emits the normal tool.* card)
 */
export function interceptGraphCall(toolName: string, args: Record<string, unknown>, result: GraphToolResult, itemId: ItemId): InterceptOutcome {
  const bare = normalizeToolName(toolName);
  const op = classifyGraphOp(toolName);
  if (!op) return { events: [], promoted: false };
  if (!GRAPH_PROMOTABLE.has(op)) return { events: [], promoted: false }; // search_code/file_symbols/overview stay text

  const nb = extractNeighborhood(op, result);
  if (nb.nodes.length < MIN_GRAPH_NODES) return { events: [], promoted: false };

  const view = layoutNeighborhood(nb);
  const subject = subjectOf(args) || (view.focusId ? labelOfFocus(view) : op);
  const events: UnsequencedChatEvent[] = [
    { type: 'graph.query', itemId, op, subject, summary: summarize(op, subject, view) },
    // No tokensSaved: the engine's figure is an estimate, and savings numbers only come from an A/B (`kora bench`).
    { type: 'graph.result', itemId, view },
  ];
  if (op === 'blast_radius') {
    const callers = view.nodes.filter((n) => n.id !== view.focusId).length;
    const files = new Set(view.nodes.map((n) => n.file).filter(Boolean)).size;
    const hazards = view.nodes.filter((n) => n.hazard).length;
    events.push({ type: 'context.blast-radius', subject, callers, files, hazards });
  }
  return { events, promoted: true };
}

/**
 * The FULL event list a kora graph MCP tool call renders as — the one place all kora
 * tool-card emission lives, so the SDK-message mapper can suppress `mcp__kora__*` blocks entirely
 * and never double-render. Promoted calls → graph.query/graph.result (+ context); small or
 * non-graph calls → a plain tool.started/tool.result pair (so `search_code` etc. still get a card,
 * §06 §3). `at` is left for the manager to stamp.
 */
export function graphToolEvents(toolName: string, args: Record<string, unknown>, result: GraphToolResult, itemId: ItemId): UnsequencedChatEvent[] {
  const outcome = interceptGraphCall(toolName, args, result, itemId);
  if (outcome.promoted) return outcome.events;
  // Fall back to a plain inline tool card carrying the raw koragraph text.
  const bare = normalizeToolName(toolName);
  const subject = subjectOf(args);
  return [
    { type: 'tool.started', itemId, toolKind: 'graph_query', toolName: bare, title: subject ? `${bare} ${subject}` : bare, input: args },
    { type: 'tool.result', itemId, status: 'completed', output: String(result?.text ?? ''), data: result?.data },
  ];
}

// ── small pure helpers ─────────────────────────────────────────────────────────
function summarize(op: GraphOp, subject: string, view: GraphView): string {
  const others = view.nodes.filter((n) => n.id !== view.focusId).length;
  const files = new Set(view.nodes.map((n) => n.file).filter(Boolean)).size;
  return `${op} ${subject} · ${others} node${others === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'}`;
}
function labelOfFocus(view: GraphView): string { return view.nodes.find((n) => n.id === view.focusId)?.label ?? ''; }
function subjectOf(args: Record<string, unknown>): string {
  return String(args?.symbol ?? args?.query ?? args?.file ?? args?.path ?? args?.name ?? '').trim();
}
function arr(v: unknown): any[] { return Array.isArray(v) ? v : []; }
function numOr(v: unknown): number | undefined { const n = Number(v); return isFinite(n) && v != null && v !== '' ? n : undefined; }
function clamp(v: number): number { return Math.max(0.06, Math.min(0.94, v)); }
function round(v: number): number { return Math.round(v * 1000) / 1000; }
function edgeKey(e: { from: string; to: string; kind: string }): string { return `${e.from} ${e.to} ${e.kind}`; }
function merge<T>(into: Map<string, T>, from: Map<string, T>): void { for (const [k, v] of from) into.set(k, v); }
