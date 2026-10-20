import { describe, expect, test, vi } from "vite-plus/test";

import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./chunkReloadGuard";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

describe("reloadOnceForChunkLoadError", () => {
  test("the first failure reloads, the second is left to surface", () => {
    const store = memoryStorage();
    const reload = vi.fn();
    const attempt = () => reloadOnceForChunkLoadError(() => store, reload);

    expect([attempt(), attempt(), attempt()]).toEqual([true, false, false]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("a good boot re-arms the guard", () => {
    const store = memoryStorage();
    const reload = vi.fn();

    reloadOnceForChunkLoadError(() => store, reload);
    clearChunkReloadGuard(() => store);

    expect(reloadOnceForChunkLoadError(() => store, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  test("when storage throws there is no reload (it could loop forever) and clearing is safe", () => {
    const reload = vi.fn();
    const denied = (): Storage => {
      throw new DOMException("no storage", "SecurityError");
    };

    expect(reloadOnceForChunkLoadError(denied, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(() => clearChunkReloadGuard(denied)).not.toThrow();
  });
});
