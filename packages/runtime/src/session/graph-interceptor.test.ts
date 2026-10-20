import { test } from 'node:test';
import assert from 'node:assert';
import {
  classifyGraphOp, normalizeToolName, extractNeighborhood, layoutNeighborhood,
  interceptGraphCall, graphToolEvents, MIN_GRAPH_NODES, MAX_GRAPH_NODES,
} from './graph-interceptor';
import type { GraphView } from './events';

// A realistic koragraph `explore` structuredContent (the shape the CLI/MCP returns).
const exploreData = {
  summary: '3 matches',
  focus: [{
    name: 'requireAuth', type: 'FUNCTION', file: 'src/auth.ts', line: 12,
    callers: [
      { name: 'handler', type: 'FUNCTION', file: 'src/api.ts', line: 4, edge_type: 'CALLS', call_line: 9 },
      { name: 'middleware', type: 'FUNCTION', file: 'src/mw.ts', line: 2, edge_type: 'CALLS' },
    ],
    callees: [
      { name: 'verifyToken', type: 'FUNCTION', file: 'src/token.ts', line: 20, edge_type: 'CALLS' },
    ],
  }],
  others: [{ name: 'AuthError', type: 'CLASS', file: 'src/auth.ts', line: 40 }],
};

test('classifyGraphOp / normalizeToolName strip MCP + kora prefixes', () => {
  assert.equal(normalizeToolName('mcp__kora__explore'), 'explore');
  assert.equal(normalizeToolName('kora_blast_radius'), 'blast_radius');
  assert.equal(classifyGraphOp('mcp__kora__neighbours'), 'neighbours');
  assert.equal(classifyGraphOp('file_symbols'), null);
  assert.equal(classifyGraphOp('Bash'), null);
});

test('extractNeighborhood reads the explore shape: focus + callers(in) + callees(out) + others', () => {
  const nb = extractNeighborhood('explore', { text: '', data: exploreData });
  assert.ok(nb.focusId && nb.focusId.startsWith('requireAuth@'));
  const byRel = (r: string) => nb.nodes.filter((n) => n.rel === r).map((n) => n.label).sort();
  assert.deepEqual(byRel('focus'), ['requireAuth']);
  assert.deepEqual(byRel('in'), ['handler', 'middleware']);
  assert.deepEqual(byRel('out'), ['verifyToken']);
  assert.deepEqual(byRel('other'), ['AuthError']);
  // caller edges point INTO the focus; callee edges point OUT of it.
  assert.ok(nb.edges.some((e) => e.to === nb.focusId && e.kind === 'calls'));
  assert.ok(nb.edges.some((e) => e.from === nb.focusId && e.kind === 'calls'));
});

test('extractNeighborhood falls back to parsing "name @ file:line" text', () => {
  const text = ['■ requireAuth @ src/auth.ts:12', '  handler @ src/api.ts:4', '  middleware @ src/mw.ts:2'].join('\n');
  const nb = extractNeighborhood('neighbours', { text, data: null });
  assert.equal(nb.nodes.length, 3);
  assert.ok(nb.focusId && nb.focusId.startsWith('requireAuth@'));
  assert.equal(nb.nodes.find((n) => n.label === 'handler')!.file, 'src/api.ts');
  assert.equal(nb.nodes.find((n) => n.label === 'handler')!.line, 4);
});

test('changes_with edges are classified as cochange', () => {
  const nb = extractNeighborhood('changes_with', { text: '', data: exploreData });
  assert.ok(nb.edges.length > 0);
  assert.ok(nb.edges.every((e) => e.kind === 'cochange'));
});

test('layoutNeighborhood: all positions normalized to [0.06,0.94], focus centered, deterministic', () => {
  const nb = extractNeighborhood('explore', { text: '', data: exploreData });
  const view = layoutNeighborhood(nb);
  for (const n of view.nodes) {
    assert.ok(n.x >= 0.06 && n.x <= 0.94, `x in range: ${n.x}`);
    assert.ok(n.y >= 0.06 && n.y <= 0.94, `y in range: ${n.y}`);
  }
  const focus = view.nodes.find((n) => n.id === view.focusId)!;
  assert.deepEqual([focus.x, focus.y], [0.5, 0.5], 'focus is centered');
  // callers on the left, callees on the right
  const handler = view.nodes.find((n) => n.label === 'handler')!;
  const verify = view.nodes.find((n) => n.label === 'verifyToken')!;
  assert.ok(handler.x < 0.5 && verify.x > 0.5);
  // deterministic
  assert.deepEqual(layoutNeighborhood(nb), view);
});

test('layout flags cross-file edges as seam edges', () => {
  const nb = extractNeighborhood('explore', { text: '', data: exploreData });
  const view = layoutNeighborhood(nb);
  // handler(src/api.ts) → requireAuth(src/auth.ts) crosses a file boundary
  assert.ok(view.edges.some((e) => e.crossesSeam), 'at least one seam edge across files');
});

test('layout caps to MAX_GRAPH_NODES and drops dangling edges', () => {
  const callers = Array.from({ length: 60 }, (_, i) => ({ name: `c${i}`, type: 'FUNCTION', file: `src/f${i}.ts`, line: i, edge_type: 'CALLS' }));
  const data = { focus: [{ name: 'hot', type: 'FUNCTION', file: 'src/hot.ts', line: 1, callers, callees: [] }] };
  const view = layoutNeighborhood(extractNeighborhood('blast_radius', { text: '', data }));
  assert.ok(view.nodes.length <= MAX_GRAPH_NODES);
  const ids = new Set(view.nodes.map((n) => n.id));
  assert.ok(view.edges.every((e) => ids.has(e.from) && ids.has(e.to)), 'no edge references a dropped node');
});

test('interceptGraphCall promotes a real explore neighborhood to graph.query + graph.result', () => {
  const out = interceptGraphCall('mcp__kora__explore', { query: 'requireAuth' }, { text: 't', data: exploreData, ms: 1 }, 'item1');
  assert.equal(out.promoted, true);
  const types = out.events.map((e) => e.type);
  assert.deepEqual(types, ['graph.query', 'graph.result']);
  const q = out.events[0] as any; const r = out.events[1] as any;
  assert.equal(q.op, 'explore');
  assert.equal(q.itemId, 'item1');
  assert.equal(q.subject, 'requireAuth');
  const view: GraphView = r.view;
  assert.ok(view.nodes.length >= MIN_GRAPH_NODES);
});

test('interceptGraphCall emits context.blast-radius for a blast_radius op', () => {
  const out = interceptGraphCall('blast_radius', { symbol: 'requireAuth' }, { text: '', data: exploreData, ms: 1 }, 'i');
  const br = out.events.find((e) => e.type === 'context.blast-radius') as any;
  assert.ok(br, 'blast_radius carries an ambient blast-radius readout');
  assert.equal(br.subject, 'requireAuth');
  assert.ok(br.callers >= 1 && br.files >= 1);
});

test('interceptGraphCall does NOT promote a small neighborhood (< MIN nodes)', () => {
  const data = { focus: [{ name: 'x', type: 'FUNCTION', file: 'a.ts', line: 1, callers: [{ name: 'y', type: 'FUNCTION', file: 'b.ts', line: 2, edge_type: 'CALLS' }], callees: [] }] };
  const out = interceptGraphCall('explore', {}, { text: '', data, ms: 1 }, 'i');
  assert.equal(out.promoted, false, 'two nodes stays a plain tool card');
});

test('interceptGraphCall keeps search_code/overview as plain tool cards', () => {
  assert.equal(interceptGraphCall('search_code', {}, { text: 'a\nb\nc\nd', data: exploreData, ms: 1 }, 'i').promoted, false);
  assert.equal(interceptGraphCall('overview', {}, { text: '', data: exploreData, ms: 1 }, 'i').promoted, false);
});

test('graphToolEvents falls back to a plain tool.started/tool.result pair when not promoted', () => {
  const evs = graphToolEvents('search_code', { query: 'foo' }, { text: 'loc1\nloc2', data: null, ms: 1 }, 'card1');
  assert.deepEqual(evs.map((e) => e.type), ['tool.started', 'tool.result']);
  assert.equal((evs[0] as any).toolKind, 'graph_query');
  assert.equal((evs[0] as any).itemId, 'card1');
  assert.equal((evs[1] as any).output, 'loc1\nloc2');
});

test('graphToolEvents returns the graph card when promoted (no plain tool.* pair)', () => {
  const evs = graphToolEvents('explore', { query: 'requireAuth' }, { text: 't', data: exploreData, ms: 1 }, 'card2');
  assert.deepEqual(evs.map((e) => e.type), ['graph.query', 'graph.result']);
});
