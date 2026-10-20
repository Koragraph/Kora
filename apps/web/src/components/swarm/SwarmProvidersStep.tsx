import { SwarmProviderKeyCard } from "./SwarmProviderKeyCard";
import { Button } from "../ui/button";
import { SWARM_PROVIDER_META } from "../../util/swarm";
import { useAtomAction } from "../../atoms/use-atom-command";
import { swarmHost } from "../../atoms/swarm";
import type { SwarmProviderId, SwarmStatus, HostId } from "@kora/contracts";
import {
  type AtomActionResult,
  squashAtomActionFailure,
  isAtomActionInterrupted,
} from "@kora/client-runtime/store/runtime";
import { useState, useRef } from "react";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;

/**
 * Step 3 (and the Settings "Free providers" section): one key card per provider in preference
 * order (Zen → OpenRouter → Cerebras by default). Settings adds ↑/↓ provider-order controls.
 */
export function SwarmProvidersStep({
  hostId,
  status,
  showOrderControls = false,
  only,
  showKeyNote = true,
}: {
  readonly hostId: HostId;
  readonly status: SwarmStatus;
  readonly showOrderControls?: boolean;
  /** Render just these providers (the setup wizard groups them by worker source). */
  readonly only?: readonly SwarmProviderId[];
  readonly showKeyNote?: boolean;
}) {
  const setKey = useAtomAction(swarmHost.setKey, COMMAND_OPTIONS);
  const clearKey = useAtomAction(swarmHost.clearKey, COMMAND_OPTIONS);
  const testProvider = useAtomAction(swarmHost.testProvider, COMMAND_OPTIONS);
  const setPreferences = useAtomAction(swarmHost.setPreferences, COMMAND_OPTIONS);
  const [pending, setPending] = useState<{ provider: SwarmProviderId; action: string } | null>(
    null,
  );
  const pendingRef = useRef(false);
  const [errors, setErrors] = useState<Partial<Record<SwarmProviderId, string>>>({});

  async function run<A, E>(
    provider: SwarmProviderId,
    action: string,
    request: () => Promise<AtomActionResult<A, E>>,
  ): Promise<boolean> {
    if (pendingRef.current) {
      return false;
    }
    pendingRef.current = true;
    setPending({ provider, action });
    setErrors((current) => ({ ...current, [provider]: undefined }));
    try {
      const outcome = await request();
      if (outcome._tag !== "Failure") {
        return true;
      }
      if (!isAtomActionInterrupted(outcome)) {
        const failure = squashAtomActionFailure(outcome);
        const message = failure instanceof Error ? failure.message : `Could not ${action}.`;
        setErrors((current) => ({ ...current, [provider]: message }));
      }
      return false;
    } catch {
      setErrors((current) => ({ ...current, [provider]: `Could not ${action}.` }));
      return false;
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  const order = status.providers.map((entry) => entry.provider);
  function move(provider: SwarmProviderId, delta: -1 | 1) {
    const index = order.indexOf(provider);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return;
    const next = [...order];
    next[index] = order[target]!;
    next[target] = provider;
    void run(provider, "change the provider order", () =>
      setPreferences({ hostId, input: { providerOrder: next } }),
    );
  }

  return (
    <div className="space-y-3">
      {status.providers.map((provider, index) => {
        if (only !== undefined && !only.includes(provider.provider)) return null;
        // Provider rows this build has no card for (local servers) are set up in their own panel.
        if (!(provider.provider in SWARM_PROVIDER_META)) return null;
        const label = SWARM_PROVIDER_META[provider.provider].label;
        const busy = pending !== null;
        return (
          <SwarmProviderKeyCard
            key={provider.provider}
            provider={provider}
            pending={
              pending?.provider === provider.provider ? pending.action : busy ? "other" : null
            }
            error={errors[provider.provider] ?? null}
            onSaveKey={(apiKey) => {
              void (async () => {
                const saved = await run(provider.provider, "save the key", () =>
                  setKey({ hostId, input: { provider: provider.provider, apiKey } }),
                );
                if (saved) {
                  await run(provider.provider, "test", () =>
                    testProvider({ hostId, input: { provider: provider.provider } }),
                  );
                }
              })();
            }}
            onClearKey={() =>
              void run(provider.provider, "remove the key", () =>
                clearKey({ hostId, input: { provider: provider.provider } }),
              )
            }
            onTest={() =>
              void run(provider.provider, "test", () =>
                testProvider({ hostId, input: { provider: provider.provider } }),
              )
            }
            onEnabledChange={(enabled) =>
              void run(provider.provider, enabled ? "turn it on" : "turn it off", () =>
                setPreferences({
                  hostId,
                  input: { enabled: [{ provider: provider.provider, enabled }] },
                }),
              )
            }
            orderControls={
              showOrderControls ? (
                <div className="flex items-center gap-0.5">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Try ${label} earlier`}
                    disabled={busy || index === 0}
                    onClick={() => move(provider.provider, -1)}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Try ${label} later`}
                    disabled={busy || index === status.providers.length - 1}
                    onClick={() => move(provider.provider, 1)}
                  >
                    <ArrowDownIcon />
                  </Button>
                </div>
              ) : undefined
            }
          />
        );
      })}
      {showKeyNote ? (
        <p className="text-muted-foreground text-xs">
          Keys are stored in a private file in ~/.kora that only you can read. They are never sent
          to your lead agent and never shown again.
        </p>
      ) : null}
    </div>
  );
}
