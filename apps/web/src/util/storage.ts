import { Debouncer } from "@tanstack/react-pacer";

export interface StateStorage<Env = unknown> {
  getItem: (label: string) => string | null | Promise<string | null>;
  setItem: (label: string, val: string) => Env;
  removeItem: (label: string) => Env;
}

export interface DeferredStorage<ValueT> {
  getItem: (label: string) => string | null | Promise<string | null>;
  setItem: (label: string, val: ValueT) => void;
  removeItem: (label: string) => void;
  flush: () => void;
}

export function createMemoryStorage(): StateStorage {
  const storeObj = new Map<string, string>();
  return {
    getItem: (label) => storeObj.get(label) ?? null,
    setItem: (label, val) => {
      storeObj.set(label, val);
    },
    removeItem: (label) => {
      storeObj.delete(label);
    },
  };
}

const REQUIRED_STORAGE_METHODS = ["getItem", "setItem", "removeItem"] as const;

function isStateStorage(
  candidate: Partial<StateStorage> | null | undefined,
): candidate is StateStorage {
  if (candidate == null) return false;
  return REQUIRED_STORAGE_METHODS.every((method) => typeof candidate[method] === "function");
}

export function resolveStorage(candidate: Partial<StateStorage> | null | undefined): StateStorage {
  if (isStateStorage(candidate)) return candidate;
  return createMemoryStorage();
}

/** Keep the latest value and serialize it when the debounce fires or `flush` runs. */
export function createDeferredStorage<ValueT>(
  baseStorage: Partial<StateStorage> | null | undefined,
  serialize: (val: ValueT) => string,
  debounceMs: number = 300,
): DeferredStorage<ValueT> {
  const resolvedStorage = resolveStorage(baseStorage);
  const debouncedSetItem = new Debouncer(
    (label: string, val: ValueT) => {
      resolvedStorage.setItem(label, serialize(val));
    },
    { wait: debounceMs },
  );

  return {
    getItem: (label) => resolvedStorage.getItem(label),
    setItem: (label, val) => {
      debouncedSetItem.maybeExecute(label, val);
    },
    removeItem: (label) => {
      debouncedSetItem.cancel();
      // cancel() leaves the captured value in Pacer's lastArgs.
      debouncedSetItem.reset();
      resolvedStorage.removeItem(label);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}
