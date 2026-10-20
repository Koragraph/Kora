import { Switch } from "../ui/switch";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { SWARM_PROVIDER_META } from "../../util/swarm";
import { localApiOrThrow } from "../../localApi";
import type {
  SwarmProviderTestResult,
  SwarmProviderLimits,
  SwarmProviderStatus,
} from "@kora/contracts";
import { type ReactNode, useState, useId } from "react";
import { ArrowUpRightIcon } from "lucide-react";

type BadgeVariant = "success" | "error" | "warning" | "outline";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function outcomePill(provider: SwarmProviderStatus): { label: string; variant: BadgeVariant } {
  if (!provider.enabled) return { label: "Off", variant: "outline" };
  const test = provider.lastTest;
  if (test === null) return { label: "Not tested", variant: "outline" };
  switch (test.outcome) {
    case "ok":
      return { label: "Works", variant: "success" };
    case "invalid-key":
      return { label: "Key rejected", variant: "error" };
    case "rate-limited":
      return { label: "Rate-limited", variant: "warning" };
    case "unreachable":
      return { label: "Unreachable", variant: "warning" };
    case "no-free-models":
      return { label: "No free models", variant: "warning" };
    case "opencode-missing":
      return { label: "Needs OpenCode", variant: "warning" };
  }
}

function outcomeText(label: string, test: SwarmProviderTestResult): string {
  switch (test.outcome) {
    case "ok": {
      const count = test.freeModels.length;
      const models = `${count} free ${count === 1 ? "model" : "models"}`;
      return test.latencyMs !== null ? `${models} · ${Math.round(test.latencyMs)} ms` : models;
    }
    case "invalid-key":
      return `${label} rejected the key. Check it and paste it again.`;
    case "rate-limited": {
      const resetsAt = test.limits?.resetsAt ?? null;
      return resetsAt !== null
        ? `Out of free requests until ${formatTime(resetsAt)}.`
        : "Out of free requests for now.";
    }
    case "unreachable":
      return `Couldn't reach ${label}. Check your connection and test again.`;
    case "no-free-models":
      return `Reached ${label}, but it offers no free models right now.`;
    case "opencode-missing":
      return "Install OpenCode first, then test again.";
  }
}

function limitsText(limits: SwarmProviderLimits | null): string | null {
  if (limits === null) return null;
  if (limits.remainingToday !== null && limits.requestsPerDay !== null) {
    return `${limits.remainingToday} / ${limits.requestsPerDay} free requests left today`;
  }
  if (limits.requestsPerDay !== null) return `${limits.requestsPerDay} free requests a day`;
  if (limits.requestsPerMinute !== null) return `${limits.requestsPerMinute} requests a minute`;
  return null;
}

function keySourceText(provider: SwarmProviderStatus): string | null {
  if (!provider.hasKey) return null;
  switch (provider.keySource) {
    case "env":
      return "Using the key from Kora's environment.";
    case "opencode-auth":
      return "Using the key from your OpenCode login.";
    case "kora":
    case null:
      return provider.keyHint !== null ? `Saved key ${provider.keyHint}` : "Key saved";
  }
}

/**
 * One free provider: what it unlocks, a key paste field (the key is never shown back; only the
 * daemon's `keyHint`), Test connection with its outcome and daily limits, and an Enabled switch.
 */
export function SwarmProviderKeyCard({
  provider,
  pending = null,
  error = null,
  onSaveKey,
  onClearKey,
  onTest,
  onEnabledChange,
  orderControls,
}: {
  readonly provider: SwarmProviderStatus;
  /** The label of the action in flight for this provider, if any. */
  readonly pending?: string | null;
  readonly error?: string | null;
  readonly onSaveKey: (apiKey: string) => void;
  readonly onClearKey: () => void;
  readonly onTest: () => void;
  readonly onEnabledChange: (enabled: boolean) => void;
  /** Provider-order buttons (Settings only). */
  readonly orderControls?: ReactNode;
}) {
  const meta = SWARM_PROVIDER_META[provider.provider];
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [keyFieldOpen, setKeyFieldOpen] = useState(false);
  const pill = outcomePill(provider);
  const test = provider.lastTest;
  const limits = limitsText(test?.limits ?? provider.limits);
  const keyLine = keySourceText(provider);
  const busy = pending !== null;
  // An optional key (Zen) stays tucked away until it is needed or the user asks for it.
  const showKeyField =
    !meta.keyOptional || keyFieldOpen || provider.hasKey || test?.outcome === "invalid-key";

  function saveKey() {
    const apiKey = draft.trim();
    if (!apiKey || busy) return;
    // Drop the typed key from UI state before it is sent: it is never rendered again.
    setDraft("");
    onSaveKey(apiKey);
  }

  return (
    <div
      data-swarm-agent-card={provider.provider}
      className="space-y-3 rounded-lg bg-card p-3 ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-foreground text-sm">{meta.label}</h3>
            <Badge size="sm" variant={pill.variant}>
              {pill.label}
            </Badge>
          </div>
          <p className="text-muted-foreground text-xs">{meta.unlocksCopy}</p>
        </div>
        {orderControls}
        <Switch
          size="sm"
          aria-label={`Use ${meta.label}`}
          checked={provider.enabled}
          disabled={busy}
          onCheckedChange={(checked) => onEnabledChange(checked === true)}
        />
      </div>

      {test !== null ? (
        <div className="space-y-0.5 text-xs" data-swarm-test-outcome={test.outcome}>
          <p className={test.ok ? "text-foreground/80" : "text-foreground"}>
            {outcomeText(meta.label, test)}
          </p>
          {test.message && test.outcome !== "ok" ? (
            <p className="text-muted-foreground [overflow-wrap:anywhere]">{test.message}</p>
          ) : null}
        </div>
      ) : null}
      {limits ? <p className="text-muted-foreground text-xs tabular-nums">{limits}</p> : null}

      {showKeyField ? (
        <div className="space-y-1.5">
          <label htmlFor={inputId} className="text-foreground text-xs font-medium">
            {meta.keyOptional ? "API key (optional)" : "API key"}
          </label>
          {keyLine ? <p className="text-muted-foreground text-xs">{keyLine}</p> : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              saveKey();
            }}
            className="flex gap-2"
          >
            <Input
              id={inputId}
              nativeInput
              size="sm"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={provider.hasKey ? "Paste a new key to replace it" : "Paste your key"}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="bg-background"
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy || !draft.trim()}>
              Save
            </Button>
          </form>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-destructive text-xs [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" variant="outline" disabled={busy} onClick={onTest}>
          {pending === "test" ? "Testing…" : "Test connection"}
        </Button>
        {meta.keyOptional && !showKeyField ? (
          <Button size="xs" variant="ghost" onClick={() => setKeyFieldOpen(true)}>
            Add {meta.label.replace(/^OpenCode /, "")} key
          </Button>
        ) : null}
        {provider.hasKey && provider.keySource === "kora" ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={onClearKey}>
            Remove key
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          className="ms-auto"
          onClick={() =>
            void localApiOrThrow()
              .shell.openExternal(meta.keyUrl)
              .catch(() => {})
          }
        >
          Get a key
          <ArrowUpRightIcon />
        </Button>
      </div>
    </div>
  );
}
