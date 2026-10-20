import { selectRunningSubprocessTerminalIds } from "@kora/client-runtime/store/terminal";
import { HostId, ThreadId, type PtySummary } from "@kora/contracts";
import { describe, expect, test, vi } from "vite-plus/test";

import { selectKnownTerminalSessions } from "./terminalSessions";

vi.mock("./terminal", () => ({ terminalHost: {} }));

const ALPHA = ThreadId.make("alpha");
const BETA = ThreadId.make("beta");
const HOST_1 = HostId.make("host-1");
const HOST_2 = HostId.make("host-2");

function pty(threadId: string, terminalId: string, over: Partial<PtySummary> = {}): PtySummary {
  return {
    label: "Terminal",
    updatedAt: "2026-09-04T00:00:00.000Z",
    hasRunningSubprocess: true,
    pid: 123,
    status: "running",
    exitSignal: null,
    exitCode: null,
    worktreePath: null,
    cwd: "/repo",
    terminalId,
    threadId,
    ...over,
  };
}
const sessionsOf = (list: PtySummary[] | null, host: HostId | null, thread: ThreadId | null) =>
  selectKnownTerminalSessions(list, host, thread);
const route = (sessions: ReturnType<typeof sessionsOf>) =>
  sessions.map((s) => `${s.target.threadId}/${s.target.terminalId}`);

describe("selectKnownTerminalSessions", () => {
  test("the metadata array is scanned once however many thread selectors ask", () => {
    const rows = Array.from({ length: 40 }, (_, n) => pty(`t${n}`, "term-1"));
    let indexReads = 0;
    const spied = new Proxy(rows, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) indexReads++;
        return Reflect.get(target, key, receiver);
      },
    });

    for (const row of rows) {
      expect(sessionsOf(spied, HOST_1, ThreadId.make(row.threadId))).toHaveLength(1);
    }
    expect(sessionsOf(spied, HOST_1, null)).toHaveLength(rows.length);
    expect(indexReads).toBe(rows.length);
  });

  test("a thread id with stray whitespace is not matched by, or mixed into, another thread's results", () => {
    const list = [pty(" padded ", "term-1"), pty(ALPHA, "term-2")];
    expect(sessionsOf(list, HOST_1, ALPHA).map((s) => s.target.threadId)).toEqual([ALPHA]);
  });

  test("no environment, no sessions, or no match all return the same frozen-empty value", () => {
    const list = [pty(ALPHA, "term-1")];
    const empty = sessionsOf(null, HOST_1, ALPHA);
    expect(sessionsOf(list, null, ALPHA)).toBe(empty);
    expect(sessionsOf([], HOST_1, null)).toBe(empty);
    expect(sessionsOf(list, HOST_1, BETA)).toBe(empty);
  });

  test("two environments sharing the same summary objects still get distinct, cached targets", () => {
    const list = [pty(ALPHA, "term-1")];
    const on1 = sessionsOf(list, HOST_1, ALPHA);
    const on2 = sessionsOf(list, HOST_2, ALPHA);

    expect([on1[0]?.target.hostId, on2[0]?.target.hostId]).toEqual([HOST_1, HOST_2]);
    expect(on1).not.toBe(on2);
    expect(on1[0]).not.toBe(on2[0]);
    expect(sessionsOf([...list], HOST_1, ALPHA)).toBe(on1);
    expect(sessionsOf([...list], HOST_2, ALPHA)).toBe(on2);
  });

  test("a change in one thread produces new results only for that thread", () => {
    const one = pty(ALPHA, "term-1");
    const two = pty(ALPHA, "term-2");
    const elsewhere = pty(BETA, "term-1");
    const before = [one, two, elsewhere];
    const alphaBefore = sessionsOf(before, HOST_1, ALPHA);
    const betaBefore = sessionsOf(before, HOST_1, BETA);
    Object.freeze(alphaBefore);
    Object.freeze(betaBefore);

    const finished = {
      ...two,
      status: "exited" as const,
      pid: null,
      exitCode: 0,
      hasRunningSubprocess: false,
      label: "Finished",
      updatedAt: "2026-09-04T00:00:01.000Z",
    };
    const after = [one, elsewhere, finished];
    const alphaAfter = sessionsOf(after, HOST_1, ALPHA);

    expect(sessionsOf(after, HOST_1, BETA)).toBe(betaBefore);
    expect(alphaAfter).not.toBe(alphaBefore);
    expect(alphaAfter[0]).toBe(alphaBefore[0]);
    expect(alphaAfter[1]?.state).toMatchObject({
      status: "exited",
      hasRunningSubprocess: false,
      summary: { label: "Finished", pid: null, exitCode: 0 },
    });
    expect(selectRunningSubprocessTerminalIds(alphaAfter)).toEqual(["term-1"]);
    // the earlier snapshot is untouched
    expect(alphaBefore[1]?.state).toMatchObject({
      status: "running",
      summary: { label: "Terminal", pid: 123 },
    });
    expect(sessionsOf(before, HOST_1, ALPHA)).toBe(alphaBefore);

    // now only beta changes: alpha's result is reused as is
    const renamed = [one, finished, { ...elsewhere, label: "Renamed" }];
    expect(sessionsOf(renamed, HOST_1, ALPHA)).toBe(alphaAfter);
    expect(sessionsOf(renamed, HOST_1, BETA)[0]?.state.summary?.label).toBe("Renamed");

    expect(sessionsOf([elsewhere], HOST_1, ALPHA)).toEqual([]);
    expect(sessionsOf([elsewhere], HOST_1, BETA)).toBe(betaBefore);
  });

  test("terminals sort by numeric suffix; equal numbers keep a stable order that survives input shuffling", () => {
    const list = [
      pty(BETA, "term-2"),
      pty(ALPHA, "term-10"),
      pty(BETA, "term-1"),
      pty(ALPHA, "term-1"),
      pty(ALPHA, "term-01"),
    ];
    const everything = sessionsOf(list, HOST_1, null);
    const justBeta = sessionsOf(list, HOST_1, BETA);

    expect(route(everything)).toEqual([
      "beta/term-1",
      "alpha/term-1",
      "alpha/term-01",
      "beta/term-2",
      "alpha/term-10",
    ]);
    expect(justBeta.map((s) => s.target.terminalId)).toEqual(["term-1", "term-2"]);
    expect(sessionsOf([...list], HOST_1, null)).toBe(everything);
    expect(sessionsOf([...list], HOST_1, BETA)).toBe(justBeta);

    const flipped = list.toReversed();
    expect(sessionsOf(flipped, HOST_1, BETA)).toBe(justBeta);
    expect(route(sessionsOf(flipped, HOST_1, null))).toEqual([
      "alpha/term-01",
      "alpha/term-1",
      "beta/term-1",
      "beta/term-2",
      "alpha/term-10",
    ]);
  });
});
