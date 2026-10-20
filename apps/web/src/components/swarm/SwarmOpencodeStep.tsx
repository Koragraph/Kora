import { SwarmInstallPanel } from "./SwarmInstallPanel";
import { useAtomAction } from "../../atoms/use-atom-command";
import { swarmHost } from "../../atoms/swarm";
import type { SwarmStatus, HostId } from "@kora/contracts";
import {
  isAtomActionInterrupted,
  type AtomActionResult,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import { useState, useRef } from "react";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;

/**
 * Step 2 (and the Settings "OpenCode" section): detection plus the install panel, wired to
 * `swarm.install.start` / `swarm.install.cancel` / `swarm.getStatus {probe: true}`. Install
 * progress arrives on the status stream.
 */
export function SwarmOpencodeStep({
  hostId,
  status,
  showIntro = true,
}: {
  readonly hostId: HostId;
  readonly status: SwarmStatus;
  readonly showIntro?: boolean;
}) {
  const installStart = useAtomAction(swarmHost.installStart, COMMAND_OPTIONS);
  const installCancel = useAtomAction(swarmHost.installCancel, COMMAND_OPTIONS);
  const getStatus = useAtomAction(swarmHost.getStatus, COMMAND_OPTIONS);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  async function run<A, E>(request: () => Promise<AtomActionResult<A, E>>, fallback: string) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setError(null);
    setPending(true);
    try {
      const result = await request();
      if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
        const failure = squashAtomActionFailure(result);
        setError(failure instanceof Error ? failure.message : fallback);
      }
    } catch {
      setError(fallback);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      {showIntro ? (
        <p className="text-muted-foreground text-sm">
          Swarm workers run in OpenCode, an open-source coding agent that can use free models.
        </p>
      ) : null}
      <SwarmInstallPanel
        opencode={status.opencode}
        install={status.install}
        pending={pending}
        error={error}
        onInstall={() =>
          void run(
            () => installStart({ hostId, input: { confirm: true } }),
            "Could not start the install.",
          )
        }
        onCancel={(operationId) =>
          void run(
            () => installCancel({ hostId, input: { operationId } }),
            "Could not cancel the install.",
          )
        }
        onCheckAgain={() =>
          void run(
            () => getStatus({ hostId, input: { probe: true } }),
            "Could not check for OpenCode.",
          )
        }
      />
    </div>
  );
}
