// State for one blob's Memory tab: the "You" facts shared by every blob, this blob's own facts, the Chief's team
// notes, and the two core notes. Edits and star toggles are optimistic and roll back on failure. Forgetting is
// deferred a few seconds so the toast's Undo can cancel it (the memory API retires a fact for good; there is no
// un-retire call), and any still-pending forget is flushed when the tab closes.
import type { BlobFact } from "@kora/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { registerHeldMemory, resolveHeldMemory } from "./heldStore";
import type { MemoryApi } from "./memoryApi";
import { isCurrent, sortFacts } from "./memoryModel";

export const FORGET_UNDO_MS = 6000;
const REFRESH_MS = 20_000;

export interface MemoryGroup {
  readonly facts: ReadonlyArray<BlobFact>;
  readonly core: string;
}

export type MemoryLoad =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly you: MemoryGroup;
      readonly blob: MemoryGroup;
      readonly team: MemoryGroup | null;
    };

export interface ForgetToast {
  readonly fact: BlobFact;
  readonly undo: () => void;
}

export interface BlobMemoryController {
  readonly load: MemoryLoad;
  readonly edit: (fact: BlobFact, text: string) => Promise<string | null>;
  readonly toggleImportant: (fact: BlobFact) => Promise<void>;
  /** Hides the fact now, retires it after FORGET_UNDO_MS unless `undo` is called. */
  readonly forget: (fact: BlobFact, onToast: (toast: ForgetToast) => void) => void;
  readonly saveCore: (scope: "you" | "blob", text: string) => Promise<string | null>;
  readonly refresh: () => void;
  /** Error from the last failed write, for a toast. */
  readonly lastError: string | null;
}

export function useBlobMemory(
  api: MemoryApi,
  blobId: string,
  options: { readonly includeTeam: boolean },
): BlobMemoryController {
  const [load, setLoad] = useState<MemoryLoad>({ status: "loading" });
  const [lastError, setLastError] = useState<string | null>(null);
  const hidden = useRef(new Set<string>());
  const serverHeld = useRef(new Set<string>());
  const pendingForgets = useRef(
    new Map<string, { timer: ReturnType<typeof setTimeout>; commit: () => void }>(),
  );
  const apiRef = useRef(api);
  apiRef.current = api;
  const { includeTeam } = options;

  const fetchAll = useCallback(async () => {
    const [you, blob, team] = await Promise.all([
      apiRef.current.list("you", null),
      apiRef.current.list("blob", blobId),
      includeTeam ? apiRef.current.list("team", null) : Promise.resolve(null),
    ]);
    if (!you.ok)
      return setLoad((current) =>
        current.status === "ready" ? current : { status: "error", message: you.message },
      );
    if (!blob.ok)
      return setLoad((current) =>
        current.status === "ready" ? current : { status: "error", message: blob.message },
      );
    // Held-for-your-OK items live on the daemon: show what it lists, and drop what was decided elsewhere.
    const nowHeld = new Set<string>();
    for (const [scope, group] of [
      ["you", you],
      ["blob", blob],
      ["team", team],
    ] as const) {
      if (!group || !group.ok) continue;
      for (const item of group.value.held ?? []) {
        nowHeld.add(item.id);
        registerHeldMemory({
          receiptId: item.id,
          blobId,
          text: item.text,
          reason: item.reason,
          scope,
        });
      }
    }
    for (const id of serverHeld.current) if (!nowHeld.has(id)) resolveHeldMemory(id);
    serverHeld.current = nowHeld;
    const visible = (facts: ReadonlyArray<BlobFact>) =>
      sortFacts(facts.filter((fact) => isCurrent(fact) && !hidden.current.has(fact.id)));
    setLoad({
      status: "ready",
      you: { facts: visible(you.value.facts), core: you.value.core },
      blob: { facts: visible(blob.value.facts), core: blob.value.core },
      team: team && team.ok ? { facts: visible(team.value.facts), core: team.value.core } : null,
    });
  }, [blobId, includeTeam]);

  useEffect(() => {
    setLoad({ status: "loading" });
    void fetchAll();
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void fetchAll();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [fetchAll]);

  // Leaving the tab commits any forget still waiting on its Undo window.
  useEffect(() => {
    const pending = pendingForgets.current;
    return () => {
      for (const { timer, commit } of pending.values()) {
        clearTimeout(timer);
        commit();
      }
      pending.clear();
    };
  }, []);

  const mapFact = useCallback((id: string, change: (fact: BlobFact) => BlobFact | null) => {
    setLoad((current) => {
      if (current.status !== "ready") return current;
      const apply = (group: MemoryGroup | null): MemoryGroup | null =>
        group === null
          ? null
          : {
              ...group,
              facts: sortFacts(
                group.facts.flatMap((fact) => {
                  if (fact.id !== id) return [fact];
                  const next = change(fact);
                  return next === null ? [] : [next];
                }),
              ),
            };
      return {
        ...current,
        you: apply(current.you)!,
        blob: apply(current.blob)!,
        team: apply(current.team),
      };
    });
  }, []);

  const putBack = useCallback((fact: BlobFact) => {
    setLoad((current) => {
      if (current.status !== "ready") return current;
      const key = fact.scope === "you" ? "you" : fact.scope === "team" ? "team" : "blob";
      const group = current[key];
      if (group === null || group.facts.some((existing) => existing.id === fact.id)) return current;
      return { ...current, [key]: { ...group, facts: sortFacts([...group.facts, fact]) } };
    });
  }, []);

  const edit = useCallback(
    async (fact: BlobFact, text: string): Promise<string | null> => {
      const clean = text.trim();
      if (clean.length === 0) return "A memory needs some text. Use Forget to remove it.";
      if (clean === fact.text) return null;
      mapFact(fact.id, (current) => ({ ...current, text: clean }));
      const result = await apiRef.current.edit(fact.id, clean);
      if (result.ok) {
        mapFact(fact.id, () => result.value);
        return null;
      }
      mapFact(fact.id, () => fact);
      return result.message;
    },
    [mapFact],
  );

  const toggleImportant = useCallback(
    async (fact: BlobFact) => {
      const important = !fact.important;
      mapFact(fact.id, (current) => ({ ...current, important }));
      const result = await apiRef.current.setImportant(fact.id, important);
      if (result.ok) mapFact(fact.id, () => result.value);
      else {
        mapFact(fact.id, () => fact);
        setLastError(result.message);
      }
    },
    [mapFact],
  );

  const forget = useCallback(
    (fact: BlobFact, onToast: (toast: ForgetToast) => void) => {
      hidden.current.add(fact.id);
      mapFact(fact.id, () => null);
      const commit = () => {
        pendingForgets.current.delete(fact.id);
        void apiRef.current.forget(fact.id).then((result) => {
          if (result.ok) return;
          hidden.current.delete(fact.id);
          putBack(fact);
          setLastError(result.message);
        });
      };
      const timer = setTimeout(commit, FORGET_UNDO_MS);
      pendingForgets.current.set(fact.id, { timer, commit });
      onToast({
        fact,
        undo: () => {
          const waiting = pendingForgets.current.get(fact.id);
          if (!waiting) return;
          clearTimeout(waiting.timer);
          pendingForgets.current.delete(fact.id);
          hidden.current.delete(fact.id);
          putBack(fact);
        },
      });
    },
    [mapFact, putBack],
  );

  const saveCore = useCallback(
    async (scope: "you" | "blob", text: string): Promise<string | null> => {
      const result = await apiRef.current.setCore(scope, scope === "blob" ? blobId : null, text);
      if (!result.ok) return result.message;
      setLoad((current) =>
        current.status !== "ready"
          ? current
          : { ...current, [scope]: { ...current[scope], core: result.value.core } },
      );
      return null;
    },
    [blobId],
  );

  return useMemo(
    () => ({
      load,
      edit,
      toggleImportant,
      forget,
      saveCore,
      refresh: () => void fetchAll(),
      lastError,
    }),
    [load, edit, toggleImportant, forget, saveCore, fetchAll, lastError],
  );
}
