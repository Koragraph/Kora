import * as Schema from "effect/Schema";
import { useCallback, useMemo, useSyncExternalStore } from "react";

type Operation = "read" | "decode" | "encode" | "update" | "write" | "remove" | "notify";

export class LocalStorageOperationError extends Schema.TaggedError<LocalStorageOperationError>()(
  "LocalStorageOperationError",
  {
    cause: Schema.Defect(),
    storageKey: Schema.String,
    operation: Schema.Literals(["read", "decode", "encode", "update", "write", "remove", "notify"]),
  },
) {
  override get message() {
    return `Failed to ${this.operation} local storage item ${this.storageKey}.`;
  }
}

const CHANGE_EVENT = "kora:storage-change";

function fail(operation1: Operation, storageKey: string, reason: unknown): never {
  throw new LocalStorageOperationError({ operation: operation1, storageKey, cause: reason });
}

/** Process-local stand-in used when there is no window (tests, SSR). */
function createMemoryStorage(): Storage {
  const blob = new Map<string, string>();
  return {
    get length() {
      return blob.size;
    },
    clear: () => blob.clear(),
    getItem: (keyName) => blob.get(keyName) ?? null,
    key: (pos) => [...blob.keys()][pos] ?? null,
    removeItem: (keyName) => void blob.delete(keyName),
    setItem: (keyName, value) => void blob.set(keyName, value),
  };
}

const memoryStorage = createMemoryStorage();

// Looked up on every call so storage that becomes reachable later is picked up.
const storage = (): Storage =>
  typeof window === "undefined" ? memoryStorage : window.localStorage;

function readRaw(keyName: string): string | null {
  try {
    return storage().getItem(keyName);
  } catch (reason) {
    return fail("read", keyName, reason);
  }
}

function decodeRaw<Item, Err>(
  keyName: string,
  unparsed: string,
  schema: Schema.Codec<Item, Err>,
): Item {
  try {
    return Schema.decodeSync(Schema.fromJsonString(schema))(unparsed);
  } catch (reason) {
    return fail("decode", keyName, reason);
  }
}

export const getLocalStorageItem = <Item, Err>(
  keyName: string,
  schema: Schema.Codec<Item, Err>,
): Item | null => {
  const unparsed = readRaw(keyName);
  return unparsed === null ? null : decodeRaw(keyName, unparsed, schema);
};

export const getMigratedLocalStorageItem = <Item, Err>(
  keyName: string,
  schema: Schema.Codec<Item, Err>,
  migrate: (document: unknown) => unknown,
): Item | null => {
  let unparsed = readRaw(keyName);
  if (unparsed === null) return null;
  try {
    const decoded: unknown = JSON.parse(unparsed);
    const migrated = migrate(decoded);
    if (migrated !== decoded) {
      const rewritten = JSON.stringify(migrated);
      storage().setItem(keyName, rewritten);
      unparsed = rewritten;
    }
  } catch {
    // Unmigratable data is decoded as stored; a decode failure then surfaces normally.
  }
  return decodeRaw(keyName, unparsed, schema);
};

export const setLocalStorageItem = <Item, Err>(
  keyName: string,
  value: Item,
  schema: Schema.Codec<Item, Err>,
): void => {
  let encoded: string;
  try {
    encoded = Schema.encodeSync(Schema.fromJsonString(schema))(value);
  } catch (reason) {
    return fail("encode", keyName, reason);
  }
  try {
    storage().setItem(keyName, encoded);
  } catch (reason) {
    fail("write", keyName, reason);
  }
};

export const removeLocalStorageItem = (keyName: string): void => {
  try {
    storage().removeItem(keyName);
  } catch (reason) {
    fail("remove", keyName, reason);
  }
};

function announceChange(keyName: string): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { key: keyName } }));
  } catch (reason) {
    fail("notify", keyName, reason);
  }
}

export function useLocalStorage<Item, Err>(
  keyName: string,
  initialValue: Item,
  schema: Schema.Codec<Item, Err>,
): [Item, (value: Item | ((val: Item) => Item)) => void] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined") return () => {};
      const matches = (evt: Event) => {
        if (evt.type === "storage") {
          const k = (evt as StorageEvent).key;
          return k === null || k === keyName;
        }
        return (evt as CustomEvent<{ key: string }>).detail?.key === keyName;
      };
      const cb = (evt: Event) => {
        if (matches(evt)) onChange();
      };
      window.addEventListener("storage", cb);
      window.addEventListener(CHANGE_EVENT, cb);
      return () => {
        window.removeEventListener("storage", cb);
        window.removeEventListener(CHANGE_EVENT, cb);
      };
    },
    [keyName],
  );

  const frameSnap = useCallback((): string | null => {
    try {
      return readRaw(keyName);
    } catch (err) {
      console.error("[LOCALSTORAGE] Could not read stored value.", err);
      return null;
    }
  }, [keyName]);

  const unparsed = useSyncExternalStore(subscribe, frameSnap, frameSnap);

  const value = useMemo<Item>(() => {
    if (unparsed === null) return initialValue;
    try {
      return decodeRaw(keyName, unparsed, schema);
    } catch (err) {
      console.error("[LOCALSTORAGE] Could not decode stored value.", err);
      return initialValue;
    }
  }, [initialValue, keyName, schema, unparsed]);

  const setValue = useCallback(
    (upcoming: Item | ((val: Item) => Item)) => {
      try {
        let settled: Item | null;
        if (typeof upcoming === "function") {
          let live: Item;
          try {
            live = getLocalStorageItem(keyName, schema) ?? initialValue;
            settled = (upcoming as (val: Item) => Item)(live);
          } catch (reason) {
            return fail("update", keyName, reason);
          }
        } else {
          settled = upcoming;
        }
        if (settled === null) removeLocalStorageItem(keyName);
        else setLocalStorageItem(keyName, settled, schema);
        announceChange(keyName);
      } catch (err) {
        console.error("[LOCALSTORAGE] Could not update stored value.", err);
      }
    },
    [initialValue, keyName, schema],
  );

  return [value, setValue];
}
