import { describe, expect, it } from "vite-plus/test";

import { RENAMED_STORAGE_KEYS, runStorageMigrations } from "./storageMigrations";

function memoryStorage(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
  };
}

describe("runStorageMigrations", () => {
  it("renames legacy environment keys in app documents once and leaves other keys alone", () => {
    const storage = memoryStorage({
      "kora:ui-state:v1": JSON.stringify({
        expanded: [{ environmentId: "kora-local", threadId: "t" }],
      }),
      "kora.activeThread.v1": JSON.stringify({ environmentId: "kora-local", threadId: "t" }),
      "other-app": JSON.stringify({ environmentId: "x" }),
      "kora:plain": "not json",
    });
    runStorageMigrations(storage);
    expect(JSON.parse(storage.getItem("kora:ui-state:v1")!)).toEqual({
      expanded: [{ hostId: "kora-local", threadId: "t" }],
    });
    expect(JSON.parse(storage.getItem("kora.activeThread.v1")!)).toEqual({
      hostId: "kora-local",
      threadId: "t",
    });
    expect(JSON.parse(storage.getItem("other-app")!)).toEqual({ environmentId: "x" });
    expect(storage.getItem("kora:plain")).toBe("not json");

    storage.setItem("kora:ui-state:v1", JSON.stringify({ environmentId: "later" }));
    runStorageMigrations(storage);
    expect(JSON.parse(storage.getItem("kora:ui-state:v1")!)).toEqual({ environmentId: "later" });
  });

  it("moves every renamed storage key to its new name, keeps a newer value, and is idempotent", () => {
    const drafts = JSON.stringify({ state: { draftsByThreadKey: {} }, version: 3 });
    const storage = memoryStorage({
      "kora:composer-drafts:v1": drafts,
      "kora:client-settings:v1": JSON.stringify({ timestampFormat: "24-hour" }),
      "kora:client-prefs:v1": JSON.stringify({ timestampFormat: "12-hour" }),
      chat_thread_sidebar_width: "312",
      "kora:preview-panel-width:host:thread-1": "640",
      "kora:storage-migration:host-keys": "1",
    });
    runStorageMigrations(storage);
    expect(storage.getItem("kora:prompt-drafts:v1")).toBe(drafts);
    expect(storage.getItem("kora:composer-drafts:v1")).toBeNull();
    // Both present: the value under the new key wins and the old key is dropped.
    expect(JSON.parse(storage.getItem("kora:client-prefs:v1")!)).toEqual({
      timestampFormat: "12-hour",
    });
    expect(storage.getItem("kora:client-settings:v1")).toBeNull();
    expect(storage.getItem("kora:nav-width")).toBe("312");
    expect(storage.getItem("chat_thread_sidebar_width")).toBeNull();
    expect(storage.getItem("kora:web-panel-width:host:thread-1")).toBe("640");
    expect(storage.getItem("kora:preview-panel-width:host:thread-1")).toBeNull();

    const snapshot = [...Array(storage.length).keys()].map((index) => storage.key(index));
    runStorageMigrations(storage);
    expect([...Array(storage.length).keys()].map((index) => storage.key(index))).toEqual(snapshot);
    for (const [from] of RENAMED_STORAGE_KEYS) expect(storage.getItem(from)).toBeNull();
  });

  it("never renames env-var names or keys inside a user env map", () => {
    const storage = memoryStorage({
      "kora:launch:v1": JSON.stringify({
        environmentId: "kora-local",
        env: { MY_ENVIRONMENT: "1", myEnvironmentFlag: "x" },
        vars: { MY_ENVIRONMENT: "2" },
      }),
    });
    runStorageMigrations(storage);
    expect(JSON.parse(storage.getItem("kora:launch:v1")!)).toEqual({
      hostId: "kora-local",
      env: { MY_ENVIRONMENT: "1", myEnvironmentFlag: "x" },
      vars: { MY_ENVIRONMENT: "2" },
    });
  });

  it("does not throw when reading localStorage itself throws", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    try {
      expect(() => runStorageMigrations()).not.toThrow();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
