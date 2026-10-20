import type { ShellWebPointerEvent } from "@kora/contracts";
import { create } from "zustand";

interface BrowserPointerStoreState {
  readonly byTabId: Record<string, ShellWebPointerEvent>;
  readonly apply: (evt: ShellWebPointerEvent) => void;
  readonly clear: (tabKey: string) => void;
}

export const useBrowserPointerStore = create<BrowserPointerStoreState>()((bag) => ({
  byTabId: {},
  apply: (evt) =>
    bag((snap) => ({
      byTabId: {
        ...snap.byTabId,
        [evt.tabId]: evt,
      },
    })),
  clear: (tabKey) =>
    bag((snap) => {
      if (!(tabKey in snap.byTabId)) return snap;
      const { [tabKey]: _removed, ...byTabId } = snap.byTabId;
      return { byTabId };
    }),
}));
