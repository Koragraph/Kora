// Funny, nice names for new blobs ("suggest a name"). Same style as the starter roster (Popo, Bobble, Dimp ...).
export const BLOB_NAME_POOL = [
  "Popo",
  "Bobble",
  "Dimp",
  "Junip",
  "Tiki",
  "Zibbo",
  "Wumpy",
  "Wobbo",
  "Tibbo",
  "Mibble",
  "Zonk",
  "Plonk",
  "Fizzle",
  "Fizzle",
  "Moxie",
  "Doodle",
  "Yuzu",
  "Nimbus",
  "Pebble",
  "Tofu",
  "Wibble",
  "Snickle",
  "Boop",
  "Jellybean",
  "Kiwi",
  "Muffin",
  "Orbit",
  "Puddle",
  "Quibble",
  "Ziggy",
] as const;

/**
 * A pool name nobody on the team has. `taken` is compared case-insensitively. When the pool is used up, a numeric
 * suffix keeps it unique ("Popo 2"). `random` is injectable for tests.
 */
export function suggestBlobName(
  taken: Iterable<string>,
  random: () => number = Math.random,
  avoid: string | null = null,
): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  if (avoid) used.add(avoid.trim().toLowerCase());
  const free = BLOB_NAME_POOL.filter((n) => !used.has(n.toLowerCase()));
  if (free.length > 0) return free[Math.floor(random() * free.length)]!;
  for (let i = 2; ; i += 1) {
    const candidate = `${BLOB_NAME_POOL[Math.floor(random() * BLOB_NAME_POOL.length)]!} ${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
