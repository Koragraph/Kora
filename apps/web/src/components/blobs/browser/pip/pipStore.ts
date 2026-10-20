// Who the floating browser mini-window is showing, and whether a full browser pane (the Computer tab) is open for a blob.
// A browsing session starts when a blob's thread shows it using the browser in a turn (`signal`); red closes it until the
// next turn that browses, yellow minimizes it to a pill, green hands over to the full pane. While a full pane for the
// same blob is mounted the mini-window is not rendered, so only one live socket per blob is ever open.
import { create } from "zustand";

export type PipMode = "open" | "minimized" | "closed";

export interface PipThread {
  readonly hostId: string;
  readonly threadId: string;
}

export interface PipSession {
  readonly blobId: string;
  /** The thread whose turn is browsing: green goes there to open its Computer tab. */
  readonly thread: PipThread | null;
  readonly turn: string;
  readonly mode: PipMode;
}

interface PipStore {
  readonly session: PipSession | null;
  /** blobId -> number of mounted full browser panes. */
  readonly fullPanes: Readonly<Record<string, number>>;
  signal(input: { blobId: string; thread: PipThread | null; turn: string }): void;
  close(): void;
  minimize(): void;
  restore(): void;
  /** The browsing went quiet: nothing to show until the next signal. */
  end(): void;
  /** A full browser pane mounted for `blobId`; call the returned function when it unmounts. */
  paneMounted(blobId: string): () => void;
}

const setMode = (s: PipStore, mode: PipMode) =>
  s.session && s.session.mode !== mode ? { session: { ...s.session, mode } } : {};

export const usePipStore = create<PipStore>()((set) => ({
  session: null,
  fullPanes: {},
  signal: ({ blobId, thread, turn }) =>
    set((s) => {
      const cur = s.session;
      // the same browsing session: keep whatever the user chose (closed stays closed until the next turn)
      if (cur && cur.blobId === blobId && cur.turn === turn)
        return cur.thread || !thread ? {} : { session: { ...cur, thread } };
      return { session: { blobId, thread, turn, mode: "open" } };
    }),
  close: () => set((s) => setMode(s, "closed")),
  minimize: () => set((s) => setMode(s, "minimized")),
  restore: () => set((s) => setMode(s, "open")),
  end: () => set({ session: null }),
  paneMounted: (blobId) => {
    set((s) => ({ fullPanes: { ...s.fullPanes, [blobId]: (s.fullPanes[blobId] ?? 0) + 1 } }));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set((s) => {
        const n = (s.fullPanes[blobId] ?? 1) - 1;
        const next = { ...s.fullPanes };
        if (n > 0) next[blobId] = n;
        else delete next[blobId];
        return { fullPanes: next };
      });
    };
  },
}));

/** @public Tests start from a clean store. */
export function resetPipStoreForTests(): void {
  usePipStore.setState({ session: null, fullPanes: {} });
}
