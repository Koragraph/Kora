/**
 * Deterministic community detection for the repo report's "areas": Louvain modularity on a weighted, undirected graph of
 * files. Pure (no I/O, no randomness): nodes are visited in index order and every tie goes to the lowest index, so one
 * graph always gives one partition. The caller sorts its nodes by path, which makes the partition a function of the
 * repo's content and not of the order the store happened to return rows in.
 */

export interface WeightedEdge {
  readonly a: number;
  readonly b: number;
  readonly w: number;
}

/**
 * Louvain on `n` nodes. Returns a community label per node, relabelled 0..k-1 in order of first appearance (so the label of
 * node 0 is always 0). Nodes with no edges stay alone.
 */
export function louvain(n: number, edges: ReadonlyArray<WeightedEdge>, resolution = 1): Int32Array {
  // Level 0 adjacency: neighbour -> weight, per node (self loops carry the weight of collapsed communities).
  let adj: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());
  for (const e of edges) {
    if (e.a === e.b || !(e.w > 0)) continue;
    adj[e.a]!.set(e.b, (adj[e.a]!.get(e.b) ?? 0) + e.w);
    adj[e.b]!.set(e.a, (adj[e.b]!.get(e.a) ?? 0) + e.w);
  }
  // membership[i] = the level-0 node's current super-node.
  let membership = Int32Array.from({ length: n }, (_, i) => i);
  let size = n;
  for (let level = 0; level < 12; level += 1) {
    const { comm, moved } = oneLevel(adj, size, resolution);
    if (!moved) break;
    // Relabel communities densely, in order of first appearance.
    const dense = new Map<number, number>();
    for (let i = 0; i < size; i += 1) if (!dense.has(comm[i]!)) dense.set(comm[i]!, dense.size);
    for (let i = 0; i < n; i += 1) membership[i] = dense.get(comm[membership[i]!]!)!;
    // Collapse: one super-node per community, edge weights summed (inside weight becomes a self loop).
    const next: Array<Map<number, number>> = Array.from({ length: dense.size }, () => new Map());
    for (let i = 0; i < size; i += 1) {
      const ci = dense.get(comm[i]!)!;
      for (const [j, w] of adj[i]!) {
        const cj = dense.get(comm[j]!)!;
        next[ci]!.set(cj, (next[ci]!.get(cj) ?? 0) + w);
      }
    }
    if (dense.size === size) break;
    adj = next;
    size = dense.size;
  }
  const out = new Int32Array(n);
  const labels = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    const c = membership[i]!;
    if (!labels.has(c)) labels.set(c, labels.size);
    out[i] = labels.get(c)!;
  }
  return out;
}

/** One Louvain local-moving pass to a fixed point. `adj` may hold self loops (symmetric: counted once in the degree twice). */
function oneLevel(
  adj: ReadonlyArray<Map<number, number>>,
  size: number,
  resolution: number,
): { comm: Int32Array; moved: boolean } {
  const comm = Int32Array.from({ length: size }, (_, i) => i);
  const k = new Float64Array(size); // weighted degree (self loop counted in full, as in the collapsed graph's definition)
  let m2 = 0;
  for (let i = 0; i < size; i += 1) {
    let d = 0;
    for (const w of adj[i]!.values()) d += w;
    k[i] = d;
    m2 += d;
  }
  if (m2 === 0) return { comm, moved: false };
  const tot = Float64Array.from(k); // sum of degrees per community
  // Sorted neighbour lists make the visiting order independent of Map insertion order.
  const nbrs: Array<Array<[number, number]>> = adj.map((m) =>
    [...m.entries()].sort((x, y) => x[0] - y[0]),
  );
  let movedAny = false;
  for (let sweep = 0; sweep < 25; sweep += 1) {
    let movedNow = false;
    for (let i = 0; i < size; i += 1) {
      const ci = comm[i]!;
      // Weight from i to each neighbouring community (self loops do not pull a node anywhere).
      const toComm = new Map<number, number>();
      for (const [j, w] of nbrs[i]!) {
        if (j === i) continue;
        const cj = comm[j]!;
        toComm.set(cj, (toComm.get(cj) ?? 0) + w);
      }
      if (toComm.size === 0) continue;
      tot[ci] = tot[ci]! - k[i]!;
      // Gain of joining community c (relative to staying isolated): w_ic - resolution * tot_c * k_i / 2m.
      let best = ci;
      let bestGain = (toComm.get(ci) ?? 0) - (resolution * tot[ci]! * k[i]!) / m2;
      for (const c of [...toComm.keys()].sort((x, y) => x - y)) {
        const gain = toComm.get(c)! - (resolution * tot[c]! * k[i]!) / m2;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          best = c;
        }
      }
      tot[best] = tot[best]! + k[i]!;
      if (best !== ci) {
        comm[i] = best;
        movedNow = true;
        movedAny = true;
      }
    }
    if (!movedNow) break;
  }
  return { comm, moved: movedAny };
}
