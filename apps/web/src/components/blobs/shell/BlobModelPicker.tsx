import { cn } from "~/util/utils";
import { getCustomModelOptionsByInstance } from "~/modelPick";
import { usePrimaryPrefs } from "~/hooks/usePrefs";
import { EMPTY_DAEMON_AGENTS } from "~/atoms/server";
import { usePrimaryHostId, useHosts } from "~/atoms/hosts";
import {
  resolveDefaultAgentModelPick,
  deriveAgentProfileEntries,
  sortAgentProfileEntries,
  applyAgentProfilePrefs,
} from "~/agentProfiles";
import { AgentModelPicker } from "../../thread/AgentModelPicker";
import { createModelPick } from "@kora/shared/modelOptions";
// A blob's model: the app's own model picker (AgentModelPicker) over the installed providers, plus the "Best
// installed" default (Claude Sonnet if signed in -> Codex -> free OpenCode, resolved by the daemon).
import { AgentProfileId, type BlobEngine } from "@kora/contracts";
import { useMemo } from "react";

function useEngineChoices(value: BlobEngine | null) {
  const hostId = usePrimaryHostId();
  const { environments } = useHosts();
  const settings = usePrimaryPrefs();
  const providers =
    environments.find((e) => e.hostId === hostId)?.daemonConfig?.providers ?? EMPTY_DAEMON_AGENTS;
  return useMemo(() => {
    const entries = sortAgentProfileEntries(
      applyAgentProfilePrefs(deriveAgentProfileEntries(providers), settings),
    );
    const selection = value
      ? { instanceId: AgentProfileId.make(value.instanceId), model: value.model }
      : resolveDefaultAgentModelPick(providers, null);
    const options = getCustomModelOptionsByInstance(
      settings,
      providers,
      selection?.instanceId,
      selection?.model,
    );
    return { entries, selection, options };
  }, [providers, settings, value]);
}

/** Just the picker (used as the chat header's model chip). */
export function BlobModelChip(props: {
  readonly value: BlobEngine | null;
  readonly onChange: (next: BlobEngine) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const { entries, selection, options } = useEngineChoices(props.value);
  if (!selection || entries.length === 0) return null;
  return (
    <AgentModelPicker
      activeInstanceId={selection.instanceId}
      modelOptionsByInstance={options}
      instanceEntries={entries}
      model={selection.model}
      triggerVariant="ghost"
      lockedProvider={null}
      size="sm"
      {...(props.disabled ? { disabled: true } : {})}
      {...(props.className ? { triggerClassName: props.className } : {})}
      onInstanceModelChange={(instanceId, model) => {
        const pick = createModelPick(instanceId, model);
        props.onChange({
          instanceId: pick.instanceId,
          model: pick.model,
          effort: props.value?.effort ?? null,
        });
      }}
    />
  );
}

/** Editor row: "Best installed" (null) or a chosen model. */
export function BlobModelField(props: {
  readonly value: BlobEngine | null;
  readonly bestLabel: string | null;
  readonly onChange: (next: BlobEngine | null) => void;
}) {
  const { value, onChange } = props;
  const { entries, selection, options } = useEngineChoices(value);
  const choose = (id: "best" | "pick") => {
    if (id === "best") onChange(null);
    else if (value === null && selection) {
      onChange({ instanceId: selection.instanceId, model: selection.model, effort: null });
    }
  };
  const cards: ReadonlyArray<{ id: "best" | "pick"; title: string; body: string }> = [
    {
      id: "best",
      title: "Best installed",
      body: props.bestLabel
        ? `Right now: ${props.bestLabel}. Follows you if you sign in to something better.`
        : "Claude if you are signed in, then Codex, then a free model.",
    },
    {
      id: "pick",
      title: "Choose a model",
      body: "Pin this blob to one model, whatever else is installed.",
    },
  ];
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Model" className="grid gap-2 sm:grid-cols-2">
        {cards.map((card) => {
          const selected = (card.id === "best") === (value === null);
          return (
            <button
              key={card.id}
              type="button"
              role="radio"
              aria-checked={selected}
              data-model-mode={card.id}
              onClick={() => choose(card.id)}
              className={cn(
                "rounded-xl p-3 text-left ring-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "bg-card ring-foreground/40" : "ring-border hover:bg-card/60",
              )}
            >
              <span className="block text-[13px] font-medium text-foreground">{card.title}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">
                {card.body}
              </span>
            </button>
          );
        })}
      </div>
      {value !== null && selection && entries.length > 0 ? (
        <div className="flex items-center gap-2">
          <AgentModelPicker
            onInstanceModelChange={(instanceId, model) => {
              const pick = createModelPick(instanceId, model);
              onChange({ instanceId: pick.instanceId, model: pick.model, effort: value.effort });
            }}
            activeInstanceId={selection.instanceId}
            modelOptionsByInstance={options}
            instanceEntries={entries}
            triggerVariant="outline"
            model={selection.model}
            lockedProvider={null}
          />
        </div>
      ) : null}
    </div>
  );
}
