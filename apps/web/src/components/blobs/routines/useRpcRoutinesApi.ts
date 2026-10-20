// The RPC-backed `RoutinesApi` (blobs.routines.*): promise-returning calls over host RPC commands, plus the change
// stream that makes the Runs tab live. Mounted once by `BlobsApiProviders`.
import { RPC_METHODS } from "@kora/contracts";
import { createHostRpcCommand } from "@kora/client-runtime/store/runtime";
import { useEffect, useMemo, useRef } from "react";

import { blobsHost } from "~/atoms/blobs";
import { usePrimaryHostId } from "~/atoms/hosts";
import { useKoraSurfaceOn } from "~/koraSurface";
import { useHostQuery } from "~/atoms/query";
import { useAtomAction } from "~/atoms/use-atom-command";
import { daemonAtomRuntime } from "~/link/runtime";
import { COMMAND_OPTIONS, useBlobRun } from "../cards/blobCommand";
import type { RoutinesApi } from "./routinesApi";

const cmd = <T extends Parameters<typeof createHostRpcCommand>[1]["tag"]>(name: string, tag: T) =>
  createHostRpcCommand(daemonAtomRuntime, { label: `blobs:routines:${name}`, tag });

const snapshotCmd = cmd("snapshot", RPC_METHODS.blobsRoutinesSnapshot);
const threadsCmd = cmd("threads", RPC_METHODS.blobsRoutinesThreads);
const previewCmd = cmd("preview", RPC_METHODS.blobsRoutinesPreview);
const saveCmd = cmd("save", RPC_METHODS.blobsRoutinesSave);
const setPausedCmd = cmd("set-paused", RPC_METHODS.blobsRoutinesSetPaused);
const removeCmd = cmd("remove", RPC_METHODS.blobsRoutinesRemove);
const runNowCmd = cmd("run-now", RPC_METHODS.blobsRoutinesRunNow);
const cancelRunCmd = cmd("cancel-run", RPC_METHODS.blobsRoutinesCancelRun);
const createTriggerCmd = cmd("create-trigger", RPC_METHODS.blobsRoutinesCreateTrigger);
const rotateTriggerCmd = cmd("rotate-trigger", RPC_METHODS.blobsRoutinesRotateTrigger);
const deleteTriggerCmd = cmd("delete-trigger", RPC_METHODS.blobsRoutinesDeleteTrigger);
const confirmCmd = cmd("confirm", RPC_METHODS.blobsRoutinesConfirm);

type Listener = { blobId: string; cb: () => void };

export function useRpcRoutinesApi(): RoutinesApi {
  const { run } = useBlobRun();
  const hostId = usePrimaryHostId();
  const snapshot = useAtomAction(snapshotCmd, COMMAND_OPTIONS);
  const threads = useAtomAction(threadsCmd, COMMAND_OPTIONS);
  const preview = useAtomAction(previewCmd, COMMAND_OPTIONS);
  const save = useAtomAction(saveCmd, COMMAND_OPTIONS);
  const setPaused = useAtomAction(setPausedCmd, COMMAND_OPTIONS);
  const remove = useAtomAction(removeCmd, COMMAND_OPTIONS);
  const runNow = useAtomAction(runNowCmd, COMMAND_OPTIONS);
  const cancelRun = useAtomAction(cancelRunCmd, COMMAND_OPTIONS);
  const createTrigger = useAtomAction(createTriggerCmd, COMMAND_OPTIONS);
  const rotateTrigger = useAtomAction(rotateTriggerCmd, COMMAND_OPTIONS);
  const deleteTrigger = useAtomAction(deleteTriggerCmd, COMMAND_OPTIONS);
  const confirm = useAtomAction(confirmCmd, COMMAND_OPTIONS);

  // The daemon's change frames: every frame re-reads the listeners of that blob (or all of them).
  const listeners = useRef(new Set<Listener>());
  // No change stream while Kora is coming soon: the daemon would only answer "Kora is coming soon".
  const koraOn = useKoraSurfaceOn();
  const frame = useHostQuery(
    hostId === null || !koraOn ? null : blobsHost.routinesChanged({ hostId, input: {} }),
  ).data as { blobId: string | null } | null;
  useEffect(() => {
    if (!frame) return;
    for (const l of [...listeners.current]) {
      if (frame.blobId === null || frame.blobId === l.blobId) l.cb();
    }
  }, [frame]);

  return useMemo<RoutinesApi>(() => {
    // The daemon's results are the contracts' (readonly) twins of the web wire types: the shapes are the same.
    const api: RoutinesApi = {
      snapshot: (blobId) =>
        run("Could not load routines.", (h) => snapshot({ hostId: h, input: { blobId } })) as never,
      threads: async (blobId) => {
        const r = await run("Could not load threads.", (h) =>
          threads({ hostId: h, input: { blobId } }),
        );
        return (r.ok ? { ok: true, value: r.value.threads } : r) as never;
      },
      preview: (cadence) =>
        run("Could not work out the schedule.", (h) =>
          preview({ hostId: h, input: { cadence } }),
        ) as never,
      save: (input) =>
        run("Could not save the routine.", (h) => save({ hostId: h, input })) as never,
      setPaused: (routineId, paused) =>
        run("Could not change the routine.", (h) =>
          setPaused({ hostId: h, input: { routineId, paused } }),
        ) as never,
      remove: async (routineId) => {
        const r = await run("Could not delete the routine.", (h) =>
          remove({ hostId: h, input: { routineId } }),
        );
        return (r.ok ? { ok: true, value: true } : r) as never;
      },
      runNow: (routineId) =>
        run("Could not start the run.", (h) =>
          runNow({ hostId: h, input: { routineId } }),
        ) as never,
      cancelRun: async (runId) => {
        const r = await run("Could not stop the run.", (h) =>
          cancelRun({ hostId: h, input: { runId } }),
        );
        return (r.ok ? { ok: true, value: true } : r) as never;
      },
      createTrigger: (routineId, label) =>
        run("Could not create the webhook.", (h) =>
          createTrigger({ hostId: h, input: { routineId, label } }),
        ) as never,
      rotateTrigger: (routineId, triggerId) =>
        run("Could not rotate the secret.", (h) =>
          rotateTrigger({ hostId: h, input: { routineId, triggerId } }),
        ) as never,
      deleteTrigger: async (routineId, triggerId) => {
        const r = await run("Could not delete the webhook.", (h) =>
          deleteTrigger({ hostId: h, input: { routineId, triggerId } }),
        );
        return (r.ok ? { ok: true, value: true } : r) as never;
      },
      confirm: (token, accept) =>
        run("Could not answer that. Try again in a moment.", (h) =>
          confirm({ hostId: h, input: { token, accept } }),
        ) as never,
      subscribe: (blobId, cb) => {
        const l = { blobId, cb };
        listeners.current.add(l);
        return () => {
          listeners.current.delete(l);
        };
      },
    };
    return api;
  }, [
    run,
    snapshot,
    threads,
    preview,
    save,
    setPaused,
    remove,
    runNow,
    cancelRun,
    createTrigger,
    rotateTrigger,
    deleteTrigger,
    confirm,
  ]);
}
