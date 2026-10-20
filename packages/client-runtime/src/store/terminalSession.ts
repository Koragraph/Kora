import type {
  HostId,
  PtyAttachStreamEvent,
  PtyMetaStreamEvent,
  PtySessionSnapshot,
  PtySummary,
  ThreadId,
} from "@kora/contracts";

import {
  type TerminalOutputState,
  resetOutput,
  EMPTY_TERMINAL_OUTPUT_STATE,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  appendOutput,
} from "./terminalOutput.ts";

export {
  type TerminalOutputUpdate,
  type TerminalOutputState,
  type TerminalOutputCursor,
  terminalOutputText,
  readTerminalOutputUpdate,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
} from "./terminalOutput.ts";

type TerminalStatus = PtySessionSnapshot["status"] | "closed";

export interface PtySessionState {
  readonly lifecycleVersion: number;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly error: string | null;
  readonly status: TerminalStatus;
  readonly output: TerminalOutputState;
  readonly summary: PtySummary | null;
}

export interface TerminalBufferState {
  readonly lifecycleVersion: number;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly error: string | null;
  readonly status: TerminalStatus;
  readonly output: TerminalOutputState;
}

export interface KnownTerminalSessionTarget {
  readonly terminalId: string;
  readonly threadId: ThreadId;
  readonly hostId: HostId;
}

export interface KnownTerminalSession {
  readonly state: PtySessionState;
  readonly target: KnownTerminalSessionTarget;
}

export const selectRunningSubprocessTerminalIds = (
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<string> => {
  const ids: string[] = [];
  for (const { state, target } of sessions) {
    if (state.hasRunningSubprocess) ids.push(target.terminalId);
  }
  return ids;
};

export const EMPTY_TERMINAL_BUFFER_STATE: Readonly<TerminalBufferState> = Object.freeze({
  lifecycleVersion: 0,
  version: 0,
  updatedAt: null,
  error: null,
  status: "closed",
  output: EMPTY_TERMINAL_OUTPUT_STATE,
});

export const EMPTY_TERMINAL_SESSION_STATE: Readonly<PtySessionState> = Object.freeze({
  lifecycleVersion: 0,
  version: 0,
  updatedAt: null,
  hasRunningSubprocess: false,
  error: null,
  status: "closed",
  output: EMPTY_TERMINAL_OUTPUT_STATE,
  summary: null,
});

// Each fresh attach starts a new output generation, so a renderer holding a cursor from an
// earlier stream reads "reset" instead of misreading offsets.
let attachGeneration = 0;

export function nextTerminalAttachSeedState(): TerminalBufferState {
  attachGeneration += 1;
  return {
    ...EMPTY_TERMINAL_BUFFER_STATE,
    output: { ...EMPTY_TERMINAL_OUTPUT_STATE, generation: attachGeneration },
  };
}

const laterTimestamp = (a: string | null, b: string | null): string | null => {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
};

export function combinePtySessionState(
  summary: PtySummary | null,
  buffer: TerminalBufferState,
): PtySessionState {
  // Once the attach stream has said anything, it is fresher than the metadata stream.
  const attachSpoke = buffer.version > 0;
  return {
    lifecycleVersion: buffer.lifecycleVersion,
    version: buffer.version,
    updatedAt: laterTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    error: buffer.error,
    status: attachSpoke ? buffer.status : (summary?.status ?? buffer.status),
    output: buffer.output,
    summary,
  };
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: PtyAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState {
  const bump = { version: current.version + 1 };
  const kind = event.type;
  if (kind === "snapshot" || kind === "restarted") {
    return {
      output: resetOutput(current.output, event.snapshot.history, maxBufferBytes),
      status: event.snapshot.status,
      error: null,
      updatedAt: event.snapshot.updatedAt,
      ...bump,
      // The first snapshot is the session's start; later ones (and restarts) begin a new life.
      lifecycleVersion:
        event.type === "snapshot" && current.version === 0
          ? current.lifecycleVersion
          : current.lifecycleVersion + 1,
    };
  }
  switch (event.type) {
    case "output": {
      const output = appendOutput(current.output, event.data, maxBufferBytes);
      const status = current.status === "closed" ? "running" : current.status;
      return { ...current, ...bump, error: null, status, output };
    }
    case "cleared":
      return {
        ...current,
        ...bump,
        error: null,
        output: resetOutput(current.output, "", maxBufferBytes),
      };
    case "exited":
      return { ...current, status: "exited", error: null, ...bump };
    case "closed":
      return { ...current, status: "closed", error: null, ...bump };
    case "error":
      return { ...current, status: "error", error: event.message, ...bump };
    case "activity":
      return current;
  }
}

const sameTerminal = (a: PtySummary, b: { threadId: string; terminalId: string }): boolean =>
  a.threadId === b.threadId && a.terminalId === b.terminalId;

export function applyTerminalMetadataStreamEvent(
  current: ReadonlyArray<PtySummary>,
  event: PtyMetaStreamEvent,
): ReadonlyArray<PtySummary> {
  switch (event.type) {
    case "snapshot":
      return event.terminals;
    case "remove":
      return current.filter((summary) => !sameTerminal(summary, event));
    case "upsert":
      // An updated terminal moves to the end of the list.
      return [
        ...current.filter((summary) => !sameTerminal(summary, event.terminal)),
        event.terminal,
      ];
  }
}
