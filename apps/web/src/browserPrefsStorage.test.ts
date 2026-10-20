import { DEFAULT_CLIENT_PREFS } from "@kora/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const STORAGE_KEY = "kora:client-prefs:v1";

/** A Storage backed by a Map, so tests can spy on individual calls. */
function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
    clear: () => entries.clear(),
    key: (index) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
  };
}

/** Puts a fresh storage (optionally pre-seeded) on `window`, then imports the module under test. */
async function loadWithStorage(initial?: string) {
  const storage = createMemoryStorage();
  if (initial !== undefined) storage.setItem(STORAGE_KEY, initial);
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("localStorage", storage);
  return { storage, ...(await import("./browserPrefsStorage")) };
}

afterEach(() => {
  vi.resetModules(); // the module under test caches its storage lookups
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reading and writing client prefs", () => {
  it("reads null before anything is saved, then returns exactly what was written", async () => {
    const { readBrowserClientPrefs, writeBrowserClientPrefs } = await loadWithStorage();
    expect(readBrowserClientPrefs()).toBeNull();

    const saved = { ...DEFAULT_CLIENT_PREFS, timestampFormat: "24-hour" as const };
    writeBrowserClientPrefs(saved);

    expect(readBrowserClientPrefs()).toEqual(saved);
  });

  it("fills a stored empty object with defaults: stacked diffs, files expanded, wrapping on", async () => {
    const { readBrowserClientPrefs } = await loadWithStorage("{}");

    expect(readBrowserClientPrefs()).toMatchObject({
      diffLayout: "stacked",
      diffFilesCollapsed: false,
      wordWrap: true,
    });
  });

  it.each([
    ["diffLayout", "split"],
    ["diffFilesCollapsed", true],
    ["diffFilesCollapsed", false],
  ] as const)("keeps %s = %s through a write and read", async (field, value) => {
    const { readBrowserClientPrefs, writeBrowserClientPrefs } = await loadWithStorage();

    writeBrowserClientPrefs({ ...DEFAULT_CLIENT_PREFS, [field]: value });

    expect(readBrowserClientPrefs()?.[field]).toBe(value);
  });

  it("discards the retired per-surface wrap flags and wraps by default", async () => {
    const { readBrowserClientPrefs } = await loadWithStorage(
      JSON.stringify({ diffWordWrap: false, chatWordWrap: false }),
    );

    const prefs = readBrowserClientPrefs();

    expect(prefs).toMatchObject({ wordWrap: true });
    expect(prefs).not.toHaveProperty("diffWordWrap");
    expect(prefs).not.toHaveProperty("chatWordWrap");
  });
});

describe("storage problems", () => {
  it("throws a contextual error for a one-time read failure without writing, then recovers", async () => {
    const saved = { ...DEFAULT_CLIENT_PREFS, timestampFormat: "12-hour" as const };
    const { storage, readBrowserClientPrefs } = await loadWithStorage(JSON.stringify(saved));
    const underlying = new Error("quota exceeded");
    vi.spyOn(storage, "getItem").mockImplementationOnce(() => {
      throw underlying;
    });
    const setItem = vi.spyOn(storage, "setItem");

    expect(() => readBrowserClientPrefs()).toThrow(
      expect.objectContaining({
        cause: underlying,
        storageKey: STORAGE_KEY,
        operation: "read",
        _tag: "LocalStorageOperationError",
      }),
    );

    expect(readBrowserClientPrefs()).toEqual(saved);
    expect(setItem).not.toHaveBeenCalled();
  });

  it.each(["{broken", '{"wordWrap":"sometimes"}'])(
    "reports undecodable stored prefs %s as an error and leaves them in place",
    async (stored) => {
      const { storage, readBrowserClientPrefs } = await loadWithStorage(stored);

      expect(() => readBrowserClientPrefs()).toThrow(
        expect.objectContaining({
          storageKey: STORAGE_KEY,
          _tag: "LocalStorageOperationError",
          operation: "decode",
        }),
      );
      expect(storage.getItem(STORAGE_KEY)).toBe(stored);
    },
  );
});
