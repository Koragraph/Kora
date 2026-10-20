// The RPC-backed `OutsideApi` (blobs.outside.*): promise-returning calls over host RPC commands. Mounted once by
// `BlobsApiProviders` so the Settings > Outside access page talks to the daemon.
import { RPC_METHODS } from "@kora/contracts";
import { createHostRpcCommand } from "@kora/client-runtime/store/runtime";
import { useMemo } from "react";

import { useAtomAction } from "~/atoms/use-atom-command";
import { daemonAtomRuntime } from "~/link/runtime";
import { COMMAND_OPTIONS, useBlobRun } from "../cards/blobCommand";
import type { OutsideApi } from "./outsideApi";

const cmd = <T extends Parameters<typeof createHostRpcCommand>[1]["tag"]>(name: string, tag: T) =>
  createHostRpcCommand(daemonAtomRuntime, { label: `blobs:outside:${name}`, tag });
const setupCmd = cmd("setup", RPC_METHODS.blobsOutsideSetup);
const tokensCmd = cmd("tokens", RPC_METHODS.blobsOutsideTokens);
const createCmd = cmd("create", RPC_METHODS.blobsOutsideCreate);
const revokeCmd = cmd("revoke", RPC_METHODS.blobsOutsideRevoke);
const auditCmd = cmd("audit", RPC_METHODS.blobsOutsideAudit);

export function useRpcOutsideApi(): OutsideApi {
  const { run } = useBlobRun();
  const setup = useAtomAction(setupCmd, COMMAND_OPTIONS);
  const tokens = useAtomAction(tokensCmd, COMMAND_OPTIONS);
  const create = useAtomAction(createCmd, COMMAND_OPTIONS);
  const revoke = useAtomAction(revokeCmd, COMMAND_OPTIONS);
  const audit = useAtomAction(auditCmd, COMMAND_OPTIONS);
  return useMemo<OutsideApi>(
    () => ({
      setup: () =>
        run("Outside access is not available yet.", (h) =>
          setup({ hostId: h, input: {} }),
        ) as never,
      tokens: async () => {
        const r = await run("Could not load the tokens.", (h) => tokens({ hostId: h, input: {} }));
        return (r.ok ? { ok: true, value: r.value.tokens } : r) as never;
      },
      create: (name) =>
        run("Could not create the token.", (h) => create({ hostId: h, input: { name } })) as never,
      revoke: async (id) => {
        const r = await run("Could not revoke the token.", (h) =>
          revoke({ hostId: h, input: { id } }),
        );
        return (r.ok ? { ok: true, value: true } : r) as never;
      },
      audit: (before) =>
        run("Could not load the activity.", (h) =>
          audit({ hostId: h, input: { before } }),
        ) as never,
    }),
    [run, setup, tokens, create, revoke, audit],
  );
}
