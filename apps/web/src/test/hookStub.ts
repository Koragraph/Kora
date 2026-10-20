import type { Dispatch, SetStateAction } from "react";

/**
 * React's state hooks without React, for tests that call a component as a plain function. Each hook call takes
 * the next slot, so state is found again by call order, as React does it; `useMemoCache` stands in for the React
 * Compiler's runtime, so compiled components run as they are.
 *
 * No value import of `react` here: this module is loaded from inside `vi.mock("react", ...)`, and a value import
 * would recurse into the mock being built. Each test file wires it up itself (vitest hoists mocks per file):
 *
 * ```ts
 * vi.mock("react", async (original) => {
 *   const { hookStub } = await import("~/test/hookStub");
 *   const { useCallback, useMemo, useRef, useState } = hookStub;
 *   return { ...(await original<typeof import("react")>()), useCallback, useMemo, useRef, useState };
 * });
 * vi.mock("react/compiler-runtime", async () => ({ c: (await import("~/test/hookStub")).hookStub.useMemoCache }));
 * ```
 *
 * Call `startRender()` before each call of the component, and `clear()` between tests.
 */
let slots: unknown[] = [];
let calls = 0;
const nextSlot = () => calls++;
const EMPTY = Symbol.for("react.memo_cache_sentinel");

export const hookStub = {
  startRender(): void {
    calls = 0;
  },
  clear(): void {
    calls = 0;
    slots = [];
  },
  useCallback<T>(callback: T): T {
    nextSlot();
    return callback;
  },
  useMemo<T>(compute: () => T): T {
    nextSlot();
    return compute();
  },
  useMemoCache(size: number): unknown[] {
    const at = nextSlot();
    slots[at] ??= new Array<unknown>(size).fill(EMPTY);
    return slots[at] as unknown[];
  },
  useRef<T>(initial: T): { current: T } {
    const at = nextSlot();
    slots[at] ??= { current: initial };
    return slots[at] as { current: T };
  },
  useState<T>(initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
    const at = nextSlot();
    if (at >= slots.length) slots[at] = initial instanceof Function ? initial() : initial;
    const set: Dispatch<SetStateAction<T>> = (next) => {
      slots[at] = next instanceof Function ? next(slots[at] as T) : next;
    };
    return [slots[at] as T, set];
  },
};
