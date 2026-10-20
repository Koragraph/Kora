import * as Schema from "effect/Schema";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

/** In-memory Storage, with any method replaceable to simulate a failure. */
function memoryStorage(patch: Partial<Storage> = {}): Storage {
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
    ...patch,
  };
}

const throwing = (cause: unknown) => () => {
  throw cause;
};

async function moduleWith(storage: Storage) {
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("localStorage", storage);
  return import("./useLocalStorage");
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("storage failures keep their context", () => {
  test("remove", async () => {
    const cause = new Error("gone");
    const mod = await moduleWith(memoryStorage({ removeItem: throwing(cause) }));
    expect(() => mod.removeLocalStorageItem("k-remove")).toThrow(mod.LocalStorageOperationError);
    try {
      mod.removeLocalStorageItem("k-remove");
    } catch (error) {
      expect(error).toMatchObject({ cause, storageKey: "k-remove", operation: "remove" });
    }
  });

  test("write", async () => {
    const cause = new Error("quota");
    const mod = await moduleWith(memoryStorage({ setItem: throwing(cause) }));
    expect.assertions(2);
    try {
      mod.setLocalStorageItem("k-write", "v", Schema.String);
    } catch (error) {
      expect(error).toBeInstanceOf(mod.LocalStorageOperationError);
      expect(error).toMatchObject({ cause, storageKey: "k-write", operation: "write" });
    }
  });

  test("read", async () => {
    const cause = new Error("unreadable");
    const mod = await moduleWith(memoryStorage({ getItem: throwing(cause) }));
    expect.assertions(2);
    try {
      mod.getLocalStorageItem("k-read", Schema.String);
    } catch (error) {
      expect(error).toBeInstanceOf(mod.LocalStorageOperationError);
      expect(error).toMatchObject({ cause, storageKey: "k-read", operation: "read" });
    }
  });

  test.each(["", "not-json", "{"])("decode of stored %j", async (stored) => {
    const mod = await moduleWith(memoryStorage({ getItem: () => stored }));
    expect.assertions(2);
    try {
      mod.getLocalStorageItem("k-decode", Schema.String);
    } catch (error) {
      expect(error).toBeInstanceOf(mod.LocalStorageOperationError);
      expect(error).toMatchObject({
        cause: expect.anything(),
        storageKey: "k-decode",
        operation: "decode",
      });
    }
  });
});

describe("round trips and recovery", () => {
  test("a written value reads back through the schema", async () => {
    const mod = await moduleWith(memoryStorage());
    mod.setLocalStorageItem("k", { n: 3 }, Schema.Struct({ n: Schema.Number }));
    expect(mod.getLocalStorageItem("k", Schema.Struct({ n: Schema.Number }))).toEqual({ n: 3 });
  });

  test("a missing key reads as null", async () => {
    const mod = await moduleWith(memoryStorage());
    expect(mod.getLocalStorageItem("absent", Schema.String)).toBeNull();
  });

  test("storage that was blocked at first works once access returns", async () => {
    const storage = memoryStorage();
    storage.setItem("k", JSON.stringify("saved"));
    let blocked = true;
    vi.stubGlobal("window", {
      get localStorage() {
        if (blocked) throw new Error("blocked");
        return storage;
      },
    });
    const mod = await import("./useLocalStorage");

    expect(() => mod.getLocalStorageItem("k", Schema.String)).toThrow(
      mod.LocalStorageOperationError,
    );
    blocked = false;
    expect(mod.getLocalStorageItem("k", Schema.String)).toBe("saved");
  });

  test("migration rewrites the stored value once, then decodes the migrated form", async () => {
    const storage = memoryStorage();
    storage.setItem("k", JSON.stringify({ old: 1 }));
    const mod = await moduleWith(storage);

    const out = mod.getMigratedLocalStorageItem(
      "k",
      Schema.Struct({ renamed: Schema.Number }),
      (doc) => ({ renamed: (doc as { old: number }).old }),
    );

    expect(out).toEqual({ renamed: 1 });
    expect(JSON.parse(storage.getItem("k")!)).toEqual({ renamed: 1 });
  });
});
