import { describe, expect, test } from "vite-plus/test";

import { LRUCache } from "./lruCache";

function filled(maxEntries: number, maxBytes: number, ...rows: Array<[string, number]>) {
  const cache = new LRUCache<string>(maxEntries, maxBytes);
  for (const [key, size] of rows) cache.set(key, key.toUpperCase(), size);
  return cache;
}
const present = (cache: LRUCache<string>, ...keys: string[]) =>
  keys.filter((k) => cache.get(k) !== null);

describe("LRUCache", () => {
  test("unknown keys read as null", () => {
    expect(filled(2, 100).get("nope")).toBeNull();
  });

  test("the entry-count limit evicts the oldest", () => {
    const cache = filled(2, 1_000, ["a", 1], ["b", 1], ["c", 1]);
    expect(present(cache, "a", "b", "c")).toEqual(["b", "c"]);
  });

  test("reading an entry protects it from the next eviction", () => {
    const cache = filled(2, 1_000, ["a", 1], ["b", 1]);
    cache.get("a");
    cache.set("c", "C", 1);
    expect(present(cache, "a", "b", "c")).toEqual(["a", "c"]);
  });

  test("the byte budget evicts as many old entries as needed", () => {
    const cache = filled(50, 25, ["a", 10], ["b", 10]);
    cache.set("big", "BIG", 20);
    expect(present(cache, "a", "b", "big")).toEqual(["big"]);
  });

  test("an item above the whole budget is refused and evicts nothing", () => {
    const cache = filled(5, 25, ["a", 10]);
    cache.set("huge", "H", 26);
    expect(present(cache, "a", "huge")).toEqual(["a"]);
  });

  test("an oversized replacement leaves the existing value in place", () => {
    const cache = filled(5, 25, ["a", 10]);
    cache.set("a", "replacement", 40);
    expect(cache.get("a")).toBe("A");
  });

  test("replacing a key frees its old size", () => {
    const cache = filled(5, 25, ["a", 20]);
    cache.set("a", "A2", 5);
    cache.set("b", "B", 20);
    expect(present(cache, "a", "b")).toEqual(["a", "b"]);
  });

  test("clear empties the cache and resets the byte count", () => {
    const cache = filled(5, 25, ["a", 20]);
    cache.clear();
    expect(cache.get("a")).toBeNull();
    cache.set("b", "B", 25);
    expect(cache.get("b")).toBe("B");
  });
});
