// The RPC-backed Engines API (engines.list / engines.do). The page holds the latest snapshot; every action answers with a
// fresh one, so there is no second source of truth to merge.
import {
  RPC_METHODS,
  type EnginesDoInput,
  type EnginesDoResult,
  type EnginesView,
} from "@kora/contracts";
import { createHostRpcCommand } from "@kora/client-runtime/store/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePrimaryHostId } from "~/atoms/hosts";
import { useAtomAction } from "~/atoms/use-atom-command";
import { daemonAtomRuntime } from "~/link/runtime";
import { COMMAND_OPTIONS, settleCommand, type ApiResult } from "../../blobs/cards/blobCommand";

const listCmd = createHostRpcCommand(daemonAtomRuntime, {
  label: "engines:list",
  tag: RPC_METHODS.enginesList,
});
const doCmd = createHostRpcCommand(daemonAtomRuntime, {
  label: "engines:do",
  tag: RPC_METHODS.enginesDo,
});

export interface EnginesApi {
  readonly ready: boolean;
  readonly view: EnginesView | null;
  readonly error: string | null;
  /** Run one action; resolves with the daemon's answer (the view inside it is already applied). */
  run: (input: EnginesDoInput) => Promise<ApiResult<EnginesDoResult>>;
  reload: () => Promise<void>;
}

/** After a failed read: 1.5 s, 3 s, 6 s, then every 15 s. A page opened while the connection is still coming up must not sit on an error. */
const retryDelay = (failures: number): number =>
  Math.min(15_000, 1_500 * 2 ** Math.max(0, failures - 1));

export function useEnginesApi(): EnginesApi {
  const hostId = usePrimaryHostId();
  const list = useAtomAction(listCmd, COMMAND_OPTIONS);
  const doIt = useAtomAction(doCmd, COMMAND_OPTIONS);
  const [view, setView] = useState<EnginesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const failures = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const again = useRef<() => Promise<void>>(async () => {});

  const reload = useCallback(async () => {
    if (hostId === null) return;
    const r = settleCommand(await list({ hostId, input: {} }), "Could not read the engines.");
    if (!alive.current) return;
    if (retry.current) clearTimeout(retry.current);
    retry.current = null;
    if (r.ok) {
      failures.current = 0;
      setView(r.value as EnginesView);
      setError(null);
      return;
    }
    failures.current += 1;
    // "not connected yet" is not news for the first tries
    if (failures.current > 3) setError(r.message);
    retry.current = setTimeout(() => void again.current(), retryDelay(failures.current));
  }, [hostId, list]);

  useEffect(() => {
    again.current = reload;
  }, [reload]);

  useEffect(() => {
    alive.current = true; // StrictMode runs the cleanup once before the real mount
    failures.current = 0;
    void reload();
    return () => {
      alive.current = false;
      if (retry.current) clearTimeout(retry.current);
    };
  }, [reload]);

  const run = useCallback(
    async (input: EnginesDoInput): Promise<ApiResult<EnginesDoResult>> => {
      if (hostId === null) return { ok: false, message: "Kora is not connected." };
      const r = settleCommand(await doIt({ hostId, input }), "That did not work. Try again.");
      if (r.ok && alive.current) setView((r.value as EnginesDoResult).view);
      return r.ok ? { ok: true, value: r.value as EnginesDoResult } : r;
    },
    [hostId, doIt],
  );

  return useMemo(
    () => ({ ready: view !== null, view, error, run, reload }),
    [view, error, run, reload],
  );
}
