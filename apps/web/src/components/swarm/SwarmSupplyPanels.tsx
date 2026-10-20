import { Switch } from "../ui/switch";
import { SelectTrigger, SelectPopup, SelectValue, SelectItem, Select } from "../ui/select";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { cn } from "../../util/utils";
import {
  LOCAL_SERVER_LABEL,
  SWARM_SUPPLY_MODES,
  parseTaskCap,
  swarmSupply,
  formatUsd,
} from "../../util/swarm";
import {
  fetchHealthReport,
  localModelServers,
  type LocalModelServer,
} from "../../util/healthCheck";
import { useAtomAction } from "../../atoms/use-atom-command";
import { swarmHost } from "../../atoms/swarm";
import { useHostHttpBaseUrl } from "../../atoms/hosts";
import type {
  SwarmSetSupplyInput,
  SwarmLocalServerId,
  SwarmSupplyMode,
  SwarmStatus,
  HostId,
} from "@kora/contracts";
import {
  isAtomActionInterrupted,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import { useCallback, useEffect, useState, useRef, useId } from "react";
import { RefreshCwIcon } from "lucide-react";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;
const ANY_MODEL = "__any__";

/**
 * Save a supply change through `swarm.setPreferences { supplyState }`. Only rendered (so only sent)
 * when the daemon reports `SwarmStatus.supplyState`, i.e. it has paid / local worker supply.
 */
function useSaveSupply(hostId: HostId) {
  const setPreferences = useAtomAction(swarmHost.setPreferences, COMMAND_OPTIONS);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(
    async (supplyState: SwarmSetSupplyInput): Promise<boolean> => {
      if (pendingRef.current) {
        return false;
      }
      pendingRef.current = true;
      setError(null);
      setPending(true);
      try {
        const outcome = await setPreferences({ hostId, input: { supplyState } });
        if (outcome._tag !== "Failure") {
          return true;
        }
        if (!isAtomActionInterrupted(outcome)) {
          const failure = squashAtomActionFailure(outcome);
          setError(failure instanceof Error ? failure.message : "Could not save the change.");
        }
        return false;
      } catch {
        setError("Could not save the change.");
        return false;
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [hostId, setPreferences],
  );
  return { save, pending, error };
}

/** Free first / paid first / local only: the order workers draw models in. */
export function SwarmSupplyModePicker({
  hostId,
  status,
}: {
  readonly hostId: HostId;
  readonly status: SwarmStatus;
}) {
  const supply = swarmSupply(status);
  const { save, pending, error } = useSaveSupply(hostId);
  if (supply === null) return null;
  return (
    <div className="space-y-1.5" data-swarm-supply-mode={supply.supply}>
      <p className="text-muted-foreground text-xs">Which models workers try first</p>
      <div
        role="radiogroup"
        aria-label="Which models workers try first"
        className="flex flex-wrap gap-1.5"
      >
        {SWARM_SUPPLY_MODES.map(({ mode, label }) => (
          <Button
            key={mode}
            size="xs"
            role="radio"
            aria-checked={supply.supply === mode}
            variant={supply.supply === mode ? "secondary" : "ghost"}
            disabled={pending}
            onClick={() => {
              if (supply.supply !== mode) void save({ supply: mode satisfies SwarmSupplyMode });
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        {SWARM_SUPPLY_MODES.find((entry) => entry.mode === supply.supply)?.detail}
      </p>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Paid OpenRouter models under a per-task cap. Needs the OpenRouter key (the provider card above
 * it) and a daemon with `SwarmStatus.supplyState`; without either it says what is missing.
 */
export function SwarmPaidModelsPanel({
  hostId,
  status,
}: {
  readonly hostId: HostId;
  readonly status: SwarmStatus;
}) {
  const supply = swarmSupply(status);
  const hasKey = status.providers.some((p) => p.provider === "openrouter" && p.hasKey);
  const { save, pending, error } = useSaveSupply(hostId);
  const capId = useId();
  const paid = supply?.paid ?? null;
  const [draft, setDraft] = useState(paid ? String(paid.maxTaskUsd) : "");
  const [draftError, setDraftError] = useState<string | null>(null);

  if (paid === null) {
    return (
      <p className="text-muted-foreground text-xs" data-swarm-paid="unavailable">
        With a key, workers use OpenRouter's free models (50 requests a day, 1000 after a one-time
        $10 credit). Paid models with a spend cap need a newer Kora.
      </p>
    );
  }

  const saveCap = () => {
    const cap = parseTaskCap(draft);
    if (cap === "invalid" || cap === null) {
      setDraftError("Enter a dollar amount per task, from $0.001 to $5.");
      return;
    }
    setDraftError(null);
    void save({ paid: { maxTaskUsd: cap } });
  };

  return (
    <div className="space-y-2" data-swarm-paid={paid.enabled ? "on" : "off"}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 text-xs">
          <p className="font-medium text-foreground text-sm">Paid models</p>
          <p className="text-muted-foreground">
            {paid.models.length > 0
              ? `Workers may use ${paid.models.join(", ")}.`
              : "Kora picks cheap, capable models."}{" "}
            A task that would cost more than the cap stops instead.
          </p>
        </div>
        <Switch
          size="sm"
          aria-label="Use paid OpenRouter models"
          checked={paid.enabled}
          disabled={pending || (!hasKey && !paid.enabled)}
          onCheckedChange={(checked) => void save({ paid: { enabled: checked === true } })}
        />
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          saveCap();
        }}
      >
        <label htmlFor={capId} className="text-foreground text-xs">
          Cap per task (USD)
        </label>
        <Input
          id={capId}
          nativeInput
          size="sm"
          inputMode="decimal"
          placeholder="0.05"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="w-24 bg-background"
        />
        <Button type="submit" size="xs" variant="outline" disabled={pending}>
          Save cap
        </Button>
        <span className="text-muted-foreground text-xs tabular-nums">
          Now {formatUsd(paid.maxTaskUsd)} a task
        </span>
      </form>
      {!hasKey ? (
        <p className="text-muted-foreground text-xs">Save your OpenRouter key above first.</p>
      ) : null}
      {draftError || error ? (
        <p role="alert" className="text-destructive text-xs">
          {draftError ?? error}
        </p>
      ) : null}
    </div>
  );
}

/** Ollama / LM Studio on this machine, found by the daemon (`/api/doctor?only=local-models`). */
function useLocalModelServers(hostId: HostId) {
  const httpBaseUrl = useHostHttpBaseUrl(hostId);
  const [servers, setServers] = useState<LocalModelServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const runId = useRef(0);
  const check = useCallback(async () => {
    if (!httpBaseUrl) return;
    const id = ++runId.current;
    setChecking(true);
    setError(null);
    try {
      const report = await fetchHealthReport(httpBaseUrl, {
        only: ["local-models"],
        probe: false,
      });
      if (id === runId.current) {
        setServers(localModelServers(report.checks.find((c) => c.id === "local-models")));
      }
    } catch (cause) {
      if (id === runId.current) {
        setError(cause instanceof Error ? cause.message : "Could not look for local models.");
      }
    } finally {
      if (id === runId.current) setChecking(false);
    }
  }, [httpBaseUrl]);
  useEffect(() => {
    void check();
  }, [check]);
  return { servers, error, checking, check };
}

function LocalServerRow({
  id,
  found,
  config,
  pending,
  onSave,
}: {
  readonly id: SwarmLocalServerId;
  readonly found: LocalModelServer | null;
  readonly config: {
    readonly enabled: boolean;
    readonly baseUrl: string;
    readonly models: readonly string[];
  };
  readonly pending: boolean;
  readonly onSave: (patch: { enabled?: boolean; baseUrl?: string; models?: string[] }) => void;
}) {
  const label = LOCAL_SERVER_LABEL[id];
  const running = found?.reachable === true;
  const models = found?.models ?? [];
  const chosen = config.models[0] ?? null;
  return (
    <li className="space-y-1.5 py-2" data-swarm-local-server={id} data-running={running}>
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1">
          <span className="font-medium text-foreground text-sm">{label}</span>{" "}
          <span className={cn(running ? "text-foreground/80" : "text-muted-foreground")}>
            {running
              ? `running · ${models.length} ${models.length === 1 ? "model" : "models"}`
              : "not running"}
          </span>
        </span>
        <Switch
          size="sm"
          aria-label={`Use ${label} for workers`}
          checked={config.enabled}
          disabled={pending || (!config.enabled && (!running || models.length === 0))}
          onCheckedChange={(checked) =>
            void onSave({
              enabled: checked === true,
              ...(found?.baseUrl ? { baseUrl: found.baseUrl } : {}),
            })
          }
        />
      </div>
      {running && models.length > 0 ? (
        <Select
          value={chosen ?? ANY_MODEL}
          disabled={pending}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            onSave({ models: value === ANY_MODEL ? [] : [value] });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-72" aria-label={`${label} worker model`}>
            <SelectValue>{chosen ?? "Any loaded model"}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value={ANY_MODEL}>
              Any loaded model
            </SelectItem>
            {models.map((model) => (
              <SelectItem key={model} hideIndicator value={model}>
                {model}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
    </li>
  );
}

/**
 * Local models: what the daemon found on this machine, and (on daemons with supply) a switch and
 * model per server. Without a running server it says how to get one.
 */
export function SwarmLocalModelsPanel({
  hostId,
  status,
}: {
  readonly hostId: HostId;
  readonly status: SwarmStatus;
}) {
  const supply = swarmSupply(status);
  const { servers, error: findError, checking, check } = useLocalModelServers(hostId);
  const { save, pending, error } = useSaveSupply(hostId);
  const up = (servers ?? []).filter((s) => s.reachable);
  const found = (id: SwarmLocalServerId) => servers?.find((s) => s.kind === id) ?? null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 text-foreground/80">
          {servers === null
            ? checking
              ? "Looking for Ollama and LM Studio…"
              : (findError ?? "Not checked yet")
            : up.length === 0
              ? "Neither Ollama nor LM Studio is running."
              : up
                  .map(
                    (s) =>
                      `${LOCAL_SERVER_LABEL[s.kind]}: ${s.models.length} ${s.models.length === 1 ? "model" : "models"}`,
                  )
                  .join(" · ")}
        </span>
        <Button size="xs" variant="ghost" disabled={checking} onClick={() => void check()}>
          <RefreshCwIcon />
          Check again
        </Button>
      </div>

      {servers !== null && up.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          Install Ollama from ollama.com and run{" "}
          <code className="rounded bg-muted px-1 font-mono text-[11px]">
            ollama pull qwen3-coder
          </code>
          , or start LM Studio's local server (port 1234). Then check again.
        </p>
      ) : up.length > 0 && up.every((s) => s.models.length === 0) ? (
        <p className="text-muted-foreground text-xs">
          The server runs but has no model yet: pull or download one, then check again.
        </p>
      ) : null}

      {supply === null ? (
        <p className="text-muted-foreground text-xs" data-swarm-local-unavailable>
          This Kora can't send workers to local models yet. Update Kora; your models will be ready
          when it can.
        </p>
      ) : (
        <ul className="divide-y divide-border/50">
          {(Object.keys(LOCAL_SERVER_LABEL) as SwarmLocalServerId[]).map((id) => (
            <LocalServerRow
              key={id}
              id={id}
              found={found(id)}
              config={supply.local[id]}
              pending={pending}
              onSave={(patch) => void save({ local: { [id]: patch } })}
            />
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
