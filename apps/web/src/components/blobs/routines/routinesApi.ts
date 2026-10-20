// The Runs tab's client API. Components receive this as a value (a context), so tests and the scratch renderer pass a
// fake; the app mounts the RPC-backed one (see packages/runtime/src/blobs/routines/WIRING.md for the methods).
import { createContext, createElement, useContext, type ReactNode } from "react";

import type { ApiResult } from "../cards/blobCommand";
import type {
  CadenceWire,
  ResultsWire,
  RoutineConfirmCardWire,
  RoutineWire,
  RunWire,
  TriggerWire,
} from "./routineModel";

export interface RoutinesSnapshot {
  routines: ReadonlyArray<RoutineWire>;
  runs: ReadonlyArray<RunWire>;
  /** The webhook receiver: where it listens and whether it is up. */
  webhook: { baseUrl: string; receiverUp: boolean };
}

export interface RoutineSaveInput {
  id: string | null;
  blobId: string;
  title: string;
  prompt: string;
  cadence: CadenceWire;
  results: ResultsWire;
  rememberLastRun: boolean;
  maxRunMinutes: number | null;
  catchUp: "none" | "one";
  paused: boolean;
}

export interface ThreadChoice {
  id: string;
  title: string;
}

export interface CadencePreview {
  words: string;
  next: ReadonlyArray<number>;
}

export interface RoutinesApi {
  snapshot: (blobId: string) => Promise<ApiResult<RoutinesSnapshot>>;
  /** Threads a report can be posted into (the blob's visible threads). */
  threads: (blobId: string) => Promise<ApiResult<ReadonlyArray<ThreadChoice>>>;
  /** Next fire times from the daemon's own schedule engine: the authority on calendar rules. */
  preview: (cadence: CadenceWire) => Promise<ApiResult<CadencePreview>>;
  save: (input: RoutineSaveInput) => Promise<ApiResult<RoutineWire>>;
  setPaused: (routineId: string, paused: boolean) => Promise<ApiResult<RoutineWire>>;
  remove: (routineId: string) => Promise<ApiResult<true>>;
  runNow: (routineId: string) => Promise<ApiResult<{ runId: string }>>;
  cancelRun: (runId: string) => Promise<ApiResult<true>>;
  /** The secret comes back on this call only. */
  createTrigger: (
    routineId: string,
    label: string,
  ) => Promise<ApiResult<{ trigger: TriggerWire; secret: string }>>;
  rotateTrigger: (
    routineId: string,
    triggerId: string,
  ) => Promise<ApiResult<{ trigger: TriggerWire; secret: string }>>;
  deleteTrigger: (routineId: string, triggerId: string) => Promise<ApiResult<true>>;
  confirm: (token: string, accept: boolean) => Promise<ApiResult<RoutineConfirmCardWire>>;
  /** Called when routines or runs change on the daemon; returns the unsubscribe. Optional (the tab also refreshes on a timer). */
  subscribe?: (blobId: string, onChange: () => void) => () => void;
}

const unavailable = async (): Promise<ApiResult<never>> => ({
  ok: false,
  message: "Routines are not connected yet.",
});

/** What the tab uses until the host mounts the real one. Every call answers "not connected". */
export const UNAVAILABLE_ROUTINES_API: RoutinesApi = {
  snapshot: unavailable,
  threads: unavailable,
  preview: unavailable,
  save: unavailable,
  setPaused: unavailable,
  remove: unavailable,
  runNow: unavailable,
  cancelRun: unavailable,
  createTrigger: unavailable,
  rotateTrigger: unavailable,
  deleteTrigger: unavailable,
  confirm: unavailable,
};

const Ctx = createContext<RoutinesApi>(UNAVAILABLE_ROUTINES_API);

export function RoutinesApiProvider(props: {
  readonly api: RoutinesApi;
  readonly children: ReactNode;
}) {
  return createElement(Ctx.Provider, { value: props.api }, props.children);
}

export function useRoutinesApi(): RoutinesApi {
  return useContext(Ctx);
}

/** Where "Open run" / "Back to results" navigate. The host supplies it (router); tests pass spies. */
export interface RoutineNav {
  openThread: (threadId: string) => void;
}
