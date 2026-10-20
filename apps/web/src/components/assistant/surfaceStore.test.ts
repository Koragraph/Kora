import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "../../hooks/useLocalStorage";
import { createElement } from "react";
import { act, create } from "react-test-renderer";

import {
  AppSurfaceSchema,
  DEFAULT_APP_SURFACE,
  migrateStoredSurface,
  normalizeStoredSurface,
  useAppSurfaceStore,
} from "./surfaceStore";

const KEY = "kora.surface.v1";

describe("surface persistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips 'blobs' and 'code' through localStorage", () => {
    setLocalStorageItem(KEY, "blobs", AppSurfaceSchema);
    expect(getLocalStorageItem(KEY, AppSurfaceSchema)).toBe("blobs");

    setLocalStorageItem(KEY, "code", AppSurfaceSchema);
    expect(getLocalStorageItem(KEY, AppSurfaceSchema)).toBe("code");
  });

  it("the retired Chat choice reads as Kora; anything unreadable is dropped", () => {
    expect(normalizeStoredSurface(null)).toBeNull();
    expect(normalizeStoredSurface('"code"')).toBe('"code"');
    expect(normalizeStoredSurface('"blobs"')).toBe('"blobs"');
    expect(normalizeStoredSurface('"chat"')).toBe('"blobs"');
    expect(normalizeStoredSurface('"something-else"')).toBeNull();
    expect(normalizeStoredSurface("not json")).toBeNull();
    const items = new Map<string, string>([[KEY, '"chat"']]);
    const storage = {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    };
    migrateStoredSurface(storage);
    expect(items.get(KEY)).toBe('"blobs"');
    items.set(KEY, "garbage");
    migrateStoredSurface(storage);
    expect(items.has(KEY)).toBe(false);
  });

  it("has no stored value before the first switch", () => {
    expect(getLocalStorageItem(`${KEY}.unused`, AppSurfaceSchema)).toBeNull();
  });

  it("a new user lands on Code; the last surface used is remembered after that", () => {
    // a minimal browser: Map-backed localStorage and no-op listeners (the unit project has no DOM)
    const items = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => items.get(k) ?? null,
        setItem: (k: string, v: string) => void items.set(k, v),
        removeItem: (k: string) => void items.delete(k),
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    });
    let seen: string | null = null;
    const Probe = () => {
      seen = useAppSurfaceStore()[0];
      return null;
    };
    removeLocalStorageItem(KEY);
    act(() => {
      create(createElement(Probe));
    });
    expect(DEFAULT_APP_SURFACE).toBe("code");
    expect(seen).toBe("code");
    setLocalStorageItem(KEY, "blobs", AppSurfaceSchema);
    act(() => {
      create(createElement(Probe));
    });
    expect(seen).toBe("blobs");
    removeLocalStorageItem(KEY);
  });
});
