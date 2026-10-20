// The RPC-backed `AppsApi` (blobs.apps.*). Mounted once by `BlobsApiProviders`.
import { RPC_METHODS } from "@kora/contracts";
import {
  squashAtomActionFailure,
  createHostRpcCommand,
  isAtomActionInterrupted,
  type AtomActionResult,
} from "@kora/client-runtime/store/runtime";
import { useCallback, useMemo } from "react";

import { usePrimaryHostId } from "~/atoms/hosts";
import { useAtomAction } from "~/atoms/use-atom-command";
import { daemonAtomRuntime } from "~/link/runtime";
import { COMMAND_OPTIONS } from "../cards/blobCommand";
import type { AppsApi, AppsResult } from "./appsApi";

const cmd = <T extends Parameters<typeof createHostRpcCommand>[1]["tag"]>(name: string, tag: T) =>
  createHostRpcCommand(daemonAtomRuntime, { label: `blobs:apps:${name}`, tag });

const statusCmd = cmd("status", RPC_METHODS.blobsAppsStatus);
const setKeyCmd = cmd("set-key", RPC_METHODS.blobsAppsSetKey);
const clearKeyCmd = cmd("clear-key", RPC_METHODS.blobsAppsClearKey);
const resetBrokerCmd = cmd("reset-broker", RPC_METHODS.blobsAppsResetBroker);
const toolkitsCmd = cmd("toolkits", RPC_METHODS.blobsAppsToolkits);
const accountsCmd = cmd("accounts", RPC_METHODS.blobsAppsAccounts);
const connectCmd = cmd("connect", RPC_METHODS.blobsAppsConnect);
const disconnectCmd = cmd("disconnect", RPC_METHODS.blobsAppsDisconnect);
const toolsCmd = cmd("tools", RPC_METHODS.blobsAppsTools);
const decisionsCmd = cmd("decisions", RPC_METHODS.blobsAppsDecisions);

/** A command result as `{ ok, value } | { ok: false, message, code }`; `code` is the BlobError code the daemon set. */
function settleCoded<A, E>(result: AtomActionResult<A, E>, fallback: string): AppsResult<A> {
  if (result._tag === "Success") return { ok: true, value: result.value };
  if (isAtomActionInterrupted(result)) return { ok: false, message: "Cancelled.", code: null };
  const failure = squashAtomActionFailure(result) as { message?: unknown; code?: unknown } | null;
  const message =
    typeof failure?.message === "string" && failure.message.trim() ? failure.message : fallback;
  return { ok: false, message, code: typeof failure?.code === "string" ? failure.code : null };
}

export function useRpcAppsApi(): AppsApi {
  const hostId = usePrimaryHostId();
  const status = useAtomAction(statusCmd, COMMAND_OPTIONS);
  const setKey = useAtomAction(setKeyCmd, COMMAND_OPTIONS);
  const clearKey = useAtomAction(clearKeyCmd, COMMAND_OPTIONS);
  const resetBroker = useAtomAction(resetBrokerCmd, COMMAND_OPTIONS);
  const toolkits = useAtomAction(toolkitsCmd, COMMAND_OPTIONS);
  const accounts = useAtomAction(accountsCmd, COMMAND_OPTIONS);
  const connect = useAtomAction(connectCmd, COMMAND_OPTIONS);
  const disconnect = useAtomAction(disconnectCmd, COMMAND_OPTIONS);
  const tools = useAtomAction(toolsCmd, COMMAND_OPTIONS);
  const decisions = useAtomAction(decisionsCmd, COMMAND_OPTIONS);

  const run = useCallback(
    async <A>(
      fallback: string,
      fn: (h: NonNullable<typeof hostId>) => Promise<AtomActionResult<A, unknown>>,
    ): Promise<AppsResult<A>> => {
      if (hostId === null)
        return { ok: false, message: "Kora is not connected.", code: "unavailable" };
      try {
        return settleCoded(await fn(hostId), fallback);
      } catch {
        return { ok: false, message: fallback, code: null };
      }
    },
    [hostId],
  );

  return useMemo<AppsApi>(
    () => ({
      status: () =>
        run("Could not read the connected apps status.", (h) => status({ hostId: h, input: {} })),
      // The key travels in `input` once and is not kept anywhere in this module.
      setKey: (key) =>
        run("Could not save that key.", (h) => setKey({ hostId: h, input: { key } })),
      clearKey: () => run("Could not remove the key.", (h) => clearKey({ hostId: h, input: {} })),
      resetBroker: () =>
        run("Could not reset the connection.", (h) => resetBroker({ hostId: h, input: {} })),
      toolkits: (search, cursor) =>
        run("Could not load the apps.", (h) => toolkits({ hostId: h, input: { search, cursor } })),
      accounts: async (toolkit) => {
        const r = await run("Could not load your connected accounts.", (h) =>
          accounts({ hostId: h, input: { toolkit } }),
        );
        return r.ok ? { ok: true, value: r.value.accounts } : r;
      },
      connect: (toolkit, alias) =>
        run("Could not start the connection.", (h) =>
          connect({ hostId: h, input: { toolkit, alias } }),
        ),
      disconnect: (accountId) =>
        run("Could not disconnect that account.", (h) =>
          disconnect({ hostId: h, input: { accountId } }),
        ),
      tools: async (toolkit) => {
        const r = await run("Could not load this app's tools.", (h) =>
          tools({ hostId: h, input: { toolkit } }),
        );
        return r.ok ? { ok: true, value: r.value.tools } : r;
      },
      decisions: async (blobId, limit) => {
        const r = await run("Could not load the activity.", (h) =>
          decisions({ hostId: h, input: { blobId, limit } }),
        );
        return r.ok ? { ok: true, value: r.value.decisions } : r;
      },
    }),
    [
      run,
      status,
      setKey,
      clearKey,
      resetBroker,
      toolkits,
      accounts,
      connect,
      disconnect,
      tools,
      decisions,
    ],
  );
}
