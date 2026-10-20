import {
  isAtomActionInterrupted,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import type { HostId, SwarmStatus } from "@kora/contracts";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { useState } from "react";

import { KORAGENT_INSTALL_COMMAND, koragentReadiness } from "../../util/swarm";
import { swarmHost } from "../../atoms/swarm";
import { useAtomAction } from "../../atoms/use-atom-command";
import { Button } from "../ui/button";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;

/**
 * Step 2 on the Koragent backend (and the Settings "Koragent" section): where Koragent is, its
 * version against the minimum, and its sha256 pin. Kora installs it from a local build or a pinned
 * URL with `kora swarm install --backend koragent`; "Check again" re-reads the binary.
 */
export function SwarmKoragentStep({
  hostId,
  status,
  showIntro = true,
}: {
  readonly hostId: HostId;
  readonly status: SwarmStatus;
  readonly showIntro?: boolean;
}) {
  const getStatus = useAtomAction(swarmHost.getStatus, COMMAND_OPTIONS);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = koragentReadiness(status);

  const checkAgain = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await getStatus({ hostId, input: { probe: true } });
      if (result._tag === "Failure" && !isAtomActionInterrupted(result)) {
        const failure = squashAtomActionFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not check for Koragent.");
      }
    } catch {
      setError("Could not check for Koragent.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-3" data-swarm-koragent-step>
      {showIntro ? (
        <p className="text-muted-foreground text-sm">
          Swarm workers run in Koragent, Kora's own coding agent: it reports its state, steers and
          failovers to Kora directly instead of being read off the screen.
        </p>
      ) : null}
      <div className="flex items-start gap-3 rounded-lg bg-card p-3 text-sm ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5">
        <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
          {state.ok ? (
            <CheckIcon className="size-3.5 text-success" aria-hidden />
          ) : (
            <CircleAlertIcon className="size-3.5 text-warning" aria-hidden />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="font-medium text-foreground">Koragent · {state.label}</span>
          {state.detail ? (
            <span className="block break-all font-mono text-muted-foreground text-xs">
              {state.detail}
            </span>
          ) : null}
          {!state.ok ? (
            <span className="mt-1 block text-muted-foreground text-xs">
              Install it from a terminal, then check again:{" "}
              <code className="font-mono text-foreground/80">{KORAGENT_INSTALL_COMMAND}</code>
            </span>
          ) : null}
        </span>
        <Button size="xs" variant="outline" disabled={pending} onClick={() => void checkAgain()}>
          Check again
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
