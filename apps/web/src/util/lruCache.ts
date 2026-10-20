interface CacheEntry<Item> {
  approximateSize: number;
  value: Item;
}

/** Least-recently-used cache bounded by entry count and by an approximate byte budget. */
export class LRUCache<Item> {
  // Map iteration order is insertion order, so the first key is always the stalest.
  private totalSize = 0;
  private cache = new Map<string, CacheEntry<Item>>();

  constructor(
    private readonly maxEntries: number,
    private readonly maxMemoryBytes: number,
  ) {}

  get(keyName: string): Item | null {
    const hit = this.cache.get(keyName);
    if (hit === undefined) return null;
    this.cache.delete(keyName);
    this.cache.set(keyName, hit);
    return hit.value;
  }

  set(keyName: string, val: Item, approximateSize: number): void {
    if (approximateSize > this.maxMemoryBytes) return;
    this.drop(keyName);
    this.makeRoomFor(approximateSize);
    this.cache.set(keyName, { approximateSize, value: val });
    this.totalSize = this.totalSize + approximateSize;
  }

  clear(): void {
    this.totalSize = 0;
    this.cache.clear();
  }

  private drop(keyName: string): void {
    const entry = this.cache.get(keyName);
    if (entry === undefined) return;
    this.totalSize -= entry.approximateSize;
    this.cache.delete(keyName);
  }

  private makeRoomFor(incomingSize: number): void {
    const overBudget = () =>
      this.cache.size >= this.maxEntries || this.totalSize + incomingSize > this.maxMemoryBytes;
    while (this.cache.size > 0 && overBudget()) {
      const stalest = this.cache.keys().next();
      if (stalest.done) break;
      this.drop(stalest.value);
    }
  }
}
