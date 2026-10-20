// Bounds for the daemon's long-lived memo maps and "done once" sets. The daemon runs for weeks and many of these are
// keyed by paths that never repeat (every swarm worker is a new worktree), so an uncapped one only ever grows.
// Insertion order is age: past `max`, the oldest quarter goes. Every caller treats a miss as "look it up again".

/** Trim `m` (a Map or Set) to 3/4 of `max` by dropping its oldest entries once it holds more than `max`. */
export function capSize<K>(m: Map<K, unknown> | Set<K>, max: number): void {
  if (m.size <= max) return;
  let drop = m.size - Math.floor(max * 0.75);
  for (const k of [...m.keys()]) { if (drop-- <= 0) break; m.delete(k); }
}
