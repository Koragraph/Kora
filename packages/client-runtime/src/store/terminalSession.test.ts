import { HostId, PtySessionSnapshot, ThreadId } from "@kora/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import * as Session from "./terminalSession.ts";

const { DEFAULT_MAX_TERMINAL_BUFFER_BYTES, EMPTY_TERMINAL_BUFFER_STATE } = Session;
const { INITIAL_TERMINAL_OUTPUT_CURSOR, readTerminalOutputUpdate, terminalOutputText } = Session;
const { applyTerminalAttachStreamEvent, applyTerminalMetadataStreamEvent } = Session;
const { combinePtySessionState, nextTerminalAttachSeedState } = Session;
const { selectRunningSubprocessTerminalIds } = Session;

const TARGET = {
  terminalId: "term-1",
  threadId: ThreadId.make("thread-7"),
  hostId: HostId.make("env-local"),
} as const;

const SNAPSHOT: PtySessionSnapshot = {
  ...{ exitCode: null, exitSignal: null, worktreePath: null },
  label: "Terminal 1",
  history: "hello",
  pid: 123,
  status: "running",
  cwd: "/work/app",
  updatedAt: "2026-05-02T00:00:00.000Z",
  terminalId: TARGET.terminalId,
  threadId: TARGET.threadId,
};

type AttachState = ReturnType<typeof applyTerminalAttachStreamEvent>;
type Cursor = typeof INITIAL_TERMINAL_OUTPUT_CURSOR;
type TerminalIds = { readonly threadId: typeof TARGET.threadId; readonly terminalId: string };

const ids: TerminalIds = { threadId: TARGET.threadId, terminalId: TARGET.terminalId };

// --- event builders -------------------------------------------------------

const snapshotEvent = (snapshot: PtySessionSnapshot = SNAPSHOT) =>
  ({ type: "snapshot", snapshot }) as const;
const outputEvent = (data: string) => ({ type: "output", ...ids, data }) as const;
const clearedEvent = () => ({ type: "cleared", ...ids }) as const;
const restartedEvent = (snapshot: PtySessionSnapshot) =>
  ({ type: "restarted", ...ids, snapshot }) as const;

/** A metadata row mirroring the snapshot, as the metadata stream would carry it. */
const metadataRow = (overrides: Record<string, unknown> = {}) => ({
  threadId: SNAPSHOT.threadId,
  terminalId: SNAPSHOT.terminalId,
  cwd: SNAPSHOT.cwd,
  worktreePath: SNAPSHOT.worktreePath,
  status: SNAPSHOT.status,
  pid: SNAPSHOT.pid,
  exitCode: SNAPSHOT.exitCode,
  exitSignal: SNAPSHOT.exitSignal,
  updatedAt: SNAPSHOT.updatedAt,
  hasRunningSubprocess: false,
  label: SNAPSHOT.label,
  ...overrides,
});

const metadataFromSnapshot = () =>
  applyTerminalMetadataStreamEvent([], {
    type: "snapshot",
    terminals: [metadataRow({ status: "running" }) as never],
  });

const attachFrom = (
  start: AttachState,
  event: Parameters<typeof applyTerminalAttachStreamEvent>[1],
  maxBytes?: number,
) => applyTerminalAttachStreamEvent(start, event, maxBytes);

const attachedWith = (history = SNAPSHOT.history, maxBytes?: number) =>
  attachFrom(EMPTY_TERMINAL_BUFFER_STATE, snapshotEvent({ ...SNAPSHOT, history }), maxBytes);

const cursorAfterRead = (state: AttachState, from = INITIAL_TERMINAL_OUTPUT_CURSOR) =>
  readTerminalOutputUpdate(state.output, from).cursor;

// --------------------------------------------------------------------------

describe("terminal session reducers", () => {
  describe("combining metadata with the attach stream", () => {
    it("lets a live attach error override stale metadata", () => {
      const [summary] = metadataFromSnapshot();
      const message = "Lost the pty.";
      const attached = attachFrom(EMPTY_TERMINAL_BUFFER_STATE, { ...ids, message, type: "error" });

      const combined = combinePtySessionState(summary!, attached);
      expect([combined.status, combined.error, combined.version]).toEqual(["error", message, 1]);
    });

    it("falls back to the metadata status until the attach stream says something", () => {
      const [summary] = metadataFromSnapshot();

      expect(combinePtySessionState(summary!, EMPTY_TERMINAL_BUFFER_STATE).status).toBe("running");
    });

    it("selects only terminals with an actual subprocess, not idle shells", () => {
      const blank = combinePtySessionState(null, EMPTY_TERMINAL_BUFFER_STATE);
      const shell = (terminalId: string, hasRunningSubprocess: boolean) => ({
        state: { ...blank, hasRunningSubprocess, status: "running" as const },
        target: { ...TARGET, terminalId },
      });

      const shells = [shell("term-1", false), shell("term-2", true)];
      expect(selectRunningSubprocessTerminalIds(shells)).toEqual(["term-2"]);
    });
  });

  describe("attach lifecycle", () => {
    it("folds a snapshot and later output into one session state", () => {
      const state = attachFrom(attachedWith(), outputEvent(" world"), 8);

      expect(state).toMatchObject({ status: "running", error: null, version: 2 });
      expect(terminalOutputText(state.output)).toBe("lo world");
    });

    it("leaves the lifecycle version at 0 for the first snapshot", () => {
      expect(attachedWith()).toMatchObject({ status: "running", lifecycleVersion: 0 });
    });

    it("bumps the lifecycle version for a later live snapshot", () => {
      const started = attachFrom(attachedWith(), snapshotEvent({ ...SNAPSHOT, pid: 456 }));

      expect(started).toMatchObject({ status: "running", lifecycleVersion: 1 });
    });

    it("bumps the lifecycle version when a running terminal restarts in place", () => {
      const before = attachedWith();
      const after = attachFrom(before, restartedEvent({ ...SNAPSHOT, pid: 456 }));

      expect(before).toMatchObject({ status: "running", lifecycleVersion: 0 });
      expect(after).toMatchObject({ status: "running", lifecycleVersion: 1 });
    });

    it("resets on repeated snapshots, clears and restarts even when the text is the same", () => {
      const resetText: string[] = [];
      let state = attachedWith();
      let cursor = cursorAfterRead(state);
      for (const event of [snapshotEvent(), clearedEvent(), restartedEvent(SNAPSHOT)]) {
        state = attachFrom(state, event);
        if (event.type === "snapshot") expect(state.version).toBe(2);
        const update = readTerminalOutputUpdate(state.output, cursor);
        if (update.type !== "reset") throw new Error(`expected a reset, got ${update.type}`);
        resetText.push(update.data);
        cursor = update.cursor;
      }
      expect(resetText).toEqual(["hello", "", "hello"]);
      expect(state.lifecycleVersion).toBe(2);
    });

    it("does not honour a renderer cursor from a different attach that has equal counters", () => {
      const first = attachFrom(nextTerminalAttachSeedState(), snapshotEvent());
      const staleCursor = cursorAfterRead(first);
      const next = attachFrom(
        nextTerminalAttachSeedState(),
        snapshotEvent({ ...SNAPSHOT, history: "other" }),
      );

      // Same counters on both attaches; only the attach identity tells them apart.
      const counters = (state: AttachState) => [state.output.resetVersion, state.output.nextOffset];
      expect(counters(next)).toEqual(counters(first));
      const update = readTerminalOutputUpdate(next.output, staleCursor);
      expect([update.type, update.type === "none" ? null : update.data]).toEqual([
        "reset",
        "other",
      ]);
      expect(next.lifecycleVersion).toBe(0);
    });
  });

  describe("metadata stream", () => {
    it("applies snapshot, upsert and remove in turn", () => {
      const apply = applyTerminalMetadataStreamEvent;
      const seeded = apply([], { terminals: [metadataRow() as never], type: "snapshot" });
      const busy = { ...seeded[0]!, hasRunningSubprocess: true };
      const upserted = apply(seeded, { terminal: busy, type: "upsert" });

      expect(upserted.map((row) => row.hasRunningSubprocess)).toEqual([true]);
      expect(apply(upserted, { ...ids, type: "remove" })).toEqual([]);
    });
  });

  describe("output buffering", () => {
    /** The renderer's next read as [type, text]; "none" reads carry no text. */
    const readAt = (state: AttachState, cursor: Cursor) => {
      const update = readTerminalOutputUpdate(state.output, cursor);
      return [update.type, update.type === "none" ? undefined : update.data] as const;
    };

    it("limits retained output by UTF-8 bytes, not characters", () => {
      const state = attachFrom(EMPTY_TERMINAL_BUFFER_STATE, outputEvent("🙂🙂"), 4);

      expect(terminalOutputText(state.output)).toBe("🙂");
    });

    it("keeps a BOM code point that starts a new output chunk", () => {
      const initial = attachedWith("");
      const cursor = cursorAfterRead(initial);
      const data = `${"x".repeat(16_384)}\uFEFF${"y".repeat(20)}`;
      const state = attachFrom(initial, outputEvent(data));

      expect(terminalOutputText(state.output)).toBe(data);
      expect(readAt(state, cursor)).toEqual(["append", data]);
      expect(state.output.retainedBytes).toBe(new TextEncoder().encode(data).byteLength);
    });

    it("keeps a leading BOM in the tail retained from a snapshot", () => {
      const state = attachedWith("discard\uFEFFtail", 7);

      expect(terminalOutputText(state.output)).toBe("\uFEFFtail");
      expect(state.output.retainedBytes).toBe(7);
    });

    it("drops whole code points when it trims part of a chunk", () => {
      // 12-byte budget over "é界🙂end" (2+3+4+3 bytes): each append evicts one leading code point.
      let state = attachedWith("é界🙂end", 12);
      let cursor = cursorAfterRead(state);
      const seen: Array<readonly [string, number]> = [];
      for (const data of ["x", "yz", "abc"]) {
        state = attachFrom(state, outputEvent(data), 12);
        const update = readTerminalOutputUpdate(state.output, cursor);
        expect(update.type === "append" && update.data).toBe(data);
        seen.push([terminalOutputText(state.output), state.output.retainedBytes]);
        cursor = update.cursor;
      }
      expect(seen).toEqual([
        ["界🙂endx", 11],
        ["🙂endxyz", 10],
        ["endxyzabc", 9],
      ]);
    });

    it("returns every chunk that landed before the renderer got to read", () => {
      const initial = attachedWith();
      let state = initial;
      for (const data of [" one", " two", " three"]) state = attachFrom(state, outputEvent(data));

      const first = readTerminalOutputUpdate(state.output, cursorAfterRead(initial));
      expect(first.type === "append" && first.data).toBe(" one two three");
      expect(readAt(state, first.cursor)).toEqual(["none", undefined]);
    });

    it("keeps the byte-limited tail and resets a cursor that points into a trimmed chunk", () => {
      const initial = attachedWith("");
      const staleCursor = cursorAfterRead(initial);
      const withHello = attachFrom(initial, outputEvent("hello"));
      const caughtUp = cursorAfterRead(withHello, staleCursor);
      const state = attachFrom(withHello, outputEvent(" world"), 8);

      expect({
        bytes: state.output.retainedBytes,
        stale: readAt(state, staleCursor),
        fresh: readAt(state, caughtUp),
      }).toEqual({ fresh: ["append", " world"], stale: ["reset", "lo world"], bytes: 8 });
    });

    it("does not re-encode the retained history on each append at the byte limit", () => {
      let state = attachedWith("x".repeat(DEFAULT_MAX_TERMINAL_BUFFER_BYTES));
      const chunk = "y".repeat(8192);
      const writes = 100;
      const encode = vi.spyOn(TextEncoder.prototype, "encode");
      try {
        for (let n = 0; n < writes; n += 1) state = attachFrom(state, outputEvent(chunk));
        let encoded = 0;
        for (const [text] of encode.mock.calls) encoded += text?.length ?? 0;
        // Only the new chunks were encoded, never the history again.
        expect(encoded).toBe(chunk.length * writes);
        expect(state.output.retainedBytes).toBe(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
      } finally {
        encode.mockRestore();
      }
    });

    it.each([0, -1])("throws output away without encoding it when the budget is %s", (budget) => {
      const initial = attachedWith();
      const cursor = cursorAfterRead(initial);
      const big = "x".repeat(65_536);
      const encode = vi.spyOn(TextEncoder.prototype, "encode");
      try {
        const dropped = attachFrom(initial, outputEvent(big), budget);
        const empty = attachFrom(initial, outputEvent(""), budget);
        expect(encode.mock.calls).toHaveLength(0);
        expect({
          offset: dropped.output.nextOffset - initial.output.nextOffset,
          bytes: dropped.output.retainedBytes,
          read: readAt(dropped, cursor),
        }).toEqual({ read: ["reset", ""], bytes: 0, offset: big.length });
        expect(empty.output).toBe(initial.output);
      } finally {
        encode.mockRestore();
      }
    });

    it("keeps appending while it compacts metadata over many tiny writes", () => {
      const writes = 2500;
      let state = attachedWith("");
      let cursor = cursorAfterRead(state);
      const pieces: string[] = [];
      while (pieces.length < writes) {
        state = attachFrom(state, outputEvent("x"));
        const update = readTerminalOutputUpdate(state.output, cursor);
        expect(update.type).toBe("append");
        if (update.type === "append") pieces.push(update.data);
        cursor = update.cursor;
      }
      const all = pieces.join("");
      expect(all).toBe("x".repeat(writes));
      expect(terminalOutputText(state.output)).toBe(all);
      expect(state.output.chunks.length).toBeLessThan(1024);
    });

    it("returns every unread character even across a compaction boundary", () => {
      const glyphs = ["x", "é", "界", "🙂"];
      const writes = Array.from({ length: 1200 }, (_, n) => glyphs[n % glyphs.length]!);
      let state = attachedWith("");
      let cursor = cursorAfterRead(state);
      writes.forEach((data, n) => {
        state = attachFrom(state, outputEvent(data));
        // The renderer reads once, after the first hundred writes, then falls behind.
        if (n === 99) cursor = cursorAfterRead(state, cursor);
      });
      expect(readAt(state, cursor)).toEqual(["append", writes.slice(100).join("")]);
    });
  });
});
