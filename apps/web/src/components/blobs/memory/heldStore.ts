// Memories a blob wanted to save but held for your OK (health, money, other people's details). The daemon exposes them
// as `held` receipts on transcript cards; there is no list call yet, so the cards register what they show here and the
// Memory tab's Pending group reads it. In-memory and per session: reopening a thread re-registers its cards.

import { useSyncExternalStore } from "react";

export interface HeldMemory {
  readonly receiptId: string;
  readonly blobId: string;
  readonly text: string;
  readonly reason: string | null;
  readonly scope: "you" | "blob" | "team";
}

let held: ReadonlyArray<HeldMemory> = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function registerHeldMemory(item: HeldMemory): void {
  if (held.some((existing) => existing.receiptId === item.receiptId)) return;
  held = [...held, item];
  emit();
}

export function resolveHeldMemory(receiptId: string): void {
  if (!held.some((existing) => existing.receiptId === receiptId)) return;
  held = held.filter((existing) => existing.receiptId !== receiptId);
  emit();
}

export function resetHeldMemoriesForTests(): void {
  held = [];
  emit();
}

const EMPTY: ReadonlyArray<HeldMemory> = [];

export function useHeldMemories(blobId: string): ReadonlyArray<HeldMemory> {
  const all = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    () => held,
    () => EMPTY,
  );
  return all.filter((item) => item.blobId === blobId);
}
