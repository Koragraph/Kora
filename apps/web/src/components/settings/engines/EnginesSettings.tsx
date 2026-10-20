import { useKoraSurfaceOn } from "../../../koraSurface";
import { cn, thisComputer, terminalAppName } from "~/util/utils";
import { fetchHealthReport, type HealthCheck } from "~/util/healthCheck";
import { canLogInFromApp } from "~/util/claudeLogin";
import { useHostHttpBaseUrl, usePrimaryHostId } from "~/atoms/hosts";
import {
  endpointNeedsKey,
  remainingPresets,
  accountWord,
  accountDot,
  statusLine,
  parseArgs,
  statusDot,
  freeSlug,
  joinArgs,
  parseEnv,
  testLine,
  slugify,
  type Dot,
} from "./enginesModel";
import { useEnginesApi, type EnginesApi } from "./enginesApi";
import { toastManager } from "../../ui/toast";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import { PrefsPageContainer, PrefsSection, PrefsRow } from "../../prefs/prefsLayout";
import { ClaudeLoginButton } from "../../onboarding/ClaudeLoginButton";
import { readLocalApi } from "../../../localApi";
// Settings > Engines: what can run a blob or a chat besides the built-in Claude / Codex / free models.
//   Built in        Claude, Codex, OpenCode, Antigravity: status, an explicit path, Re-check.
//   Claude accounts named logins, each with its own folder; the sign-in command to copy; never rotated for you.
//   Agents (ACP)    Grok, Cursor, Kimi, Qwen, Droid, Hermes, any custom CLI (Antigravity is built in).
//   API endpoints   OpenRouter, DeepSeek, Groq, LM Studio, Ollama, any URL + key (write-only; Test sends no message).
// An engine that cannot run is a row with the reason, never missing.
import type {
  EngineAccountView,
  EngineAcpView,
  EngineApiView,
  EnginesView,
  EngineRow,
} from "@kora/contracts";
import { useSyncExternalStore, useCallback, type ReactNode, useEffect, useState } from "react";
import { RefreshCwIcon, CheckIcon, CopyIcon, PlusIcon } from "lucide-react";

// The Claude row says "Ready" when the program is found; the main-login row below says whether you are signed in. Two
// verdicts on one engine must agree, so the login check publishes here and the Claude row reads it.
let mainLogin: "signed-in" | "signed-out" | "unknown" = "unknown";
const mainLoginListeners = new Set<() => void>();
function publishMainLogin(next: typeof mainLogin) {
  if (mainLogin === next) return;
  mainLogin = next;
  for (const l of mainLoginListeners) l();
}
function useMainLogin() {
  return useSyncExternalStore(
    (l) => {
      mainLoginListeners.add(l);
      return () => mainLoginListeners.delete(l);
    },
    () => mainLogin,
    () => "unknown" as const,
  );
}

function DotMark({ dot }: { dot: Dot }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        dot === "ok" ? "bg-success" : dot === "warn" ? "bg-warning" : "bg-muted-foreground/40",
      )}
    />
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] font-medium text-foreground">{label}</span>
      {children}
      {hint ? (
        <span className="block text-[11.5px] leading-snug text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

const fail = (title: string, description: string) =>
  toastManager.add({ type: "error", title, description });

export function EnginesSettings(props: { readonly anchorId?: string }) {
  const api = useEnginesApi();
  const view = api.view;
  return (
    <PrefsPageContainer>
      <p className="-mb-2 max-w-xl text-sm text-muted-foreground">
        What runs the agents: the built-in programs, extra Claude accounts and any compatible
        endpoint. Turn agents on or off in Agents.
      </p>
      {api.error && !view ? (
        <p className="py-4 text-[13px] text-muted-foreground" role="alert" data-engines-error>
          {api.error}{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => void api.reload()}
          >
            Try again
          </button>
        </p>
      ) : null}
      {!view && !api.error ? (
        <p className="py-4 text-[13px] text-muted-foreground">Looking for engines…</p>
      ) : null}
      {view ? (
        <>
          <BuiltInSection
            api={api}
            view={view}
            {...(props.anchorId ? { anchorId: props.anchorId } : {})}
          />
          <AccountsSection api={api} view={view} />
          <AcpSection api={api} view={view} />
          <ApiSection api={api} view={view} />
        </>
      ) : null}
    </PrefsPageContainer>
  );
}

// ── built in ─────────────────────────────────────────────────────────────────────────────────────────────────────
function BuiltInSection({
  api,
  view,
  anchorId,
}: {
  api: EnginesApi;
  view: EnginesView;
  anchorId?: string;
}) {
  return (
    <PrefsSection
      title="Built in"
      {...(anchorId ? { id: anchorId } : {})}
      data-engines-builtin
      headerAction={
        <Button size="xs" variant="ghost" onClick={() => void api.run({ op: "refresh" })}>
          <RefreshCwIcon /> Re-check
        </Button>
      }
    >
      {view.engines.map((e) => (
        <BuiltInRow key={e.id} api={api} row={e} />
      ))}
    </PrefsSection>
  );
}

function BuiltInRow({ api, row }: { api: EnginesApi; row: EngineRow }) {
  const [path, setPath] = useState(row.explicitPath ? (row.executable ?? "") : "");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const engine = row.id as "claude" | "codex" | "opencode" | "antigravity";
  const login = useMainLogin();
  const signedOut = engine === "claude" && row.available && login === "signed-out";
  const save = async (value: string | null) => {
    setBusy(true);
    const r = await api.run({ op: "exe.set", engine, path: value });
    setBusy(false);
    if (!r.ok) fail("Could not save the path", r.message);
  };
  return (
    <PrefsRow
      data-engine-row={row.id}
      title={
        <span className="flex items-center gap-2">
          <DotMark dot={signedOut ? "warn" : statusDot(row)} />
          {row.label}
        </span>
      }
      description={
        signedOut
          ? "Installed, but you are not signed in. See Your main login below."
          : statusLine(row)
      }
      control={
        <Button size="xs" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          Path
        </Button>
      }
    >
      {open ? (
        <div className="mt-3 flex max-w-xl items-center gap-2">
          <Input
            size="sm"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="Search automatically"
            aria-label={`${row.label} path`}
            spellCheck={false}
          />
          <Button
            size="xs"
            disabled={busy}
            onClick={() => void save(path.trim() || null)}
            data-exe-save
          >
            Save
          </Button>
          {row.explicitPath ? (
            <Button
              onClick={() => {
                setPath("");
                void save(null);
              }}
              variant="ghost"
              disabled={busy}
              size="xs"
            >
              Clear
            </Button>
          ) : null}
        </div>
      ) : null}
    </PrefsRow>
  );
}

// ── Claude accounts ──────────────────────────────────────────────────────────────────────────────────────────────
function AccountsSection({ api, view }: { api: EnginesApi; view: EnginesView }) {
  const [adding, setAdding] = useState(false);
  return (
    <PrefsSection
      title="Claude accounts"
      data-engines-accounts
      headerAction={
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setAdding((v) => !v)}
          data-account-add-toggle
        >
          <PlusIcon /> Add account
        </Button>
      }
    >
      <MainLoginRow />
      {view.accounts.map((a) => (
        <AccountRow key={a.name} api={api} account={a} />
      ))}
      {adding ? <AddAccount api={api} onDone={() => setAdding(false)} /> : null}
    </PrefsSection>
  );
}

/** What Settings can say about the Claude you already use: the health check's own `claude-auth` row, with the way to sign in. */
export function MainLoginRow({
  checkFor,
}: { readonly checkFor?: () => Promise<HealthCheck | null> } = {}) {
  const hostId = usePrimaryHostId();
  const httpBaseUrl = useHostHttpBaseUrl(hostId);
  const [check, setCheck] = useState<HealthCheck | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unknown">("loading");
  const load = useCallback(async () => {
    try {
      const found = checkFor
        ? await checkFor()
        : httpBaseUrl
          ? ((
              await fetchHealthReport(httpBaseUrl, { only: ["claude-auth"], probe: false })
            ).checks.find((c) => c.id === "claude-auth") ?? null)
          : null;
      setCheck(found);
      setState(found ? "ready" : "unknown");
    } catch {
      setState("unknown");
    }
  }, [httpBaseUrl, checkFor]);
  useEffect(() => {
    void load();
  }, [load]);

  const signedIn = check?.status === "ok";
  useEffect(() => {
    publishMainLogin(state === "ready" ? (signedIn ? "signed-in" : "signed-out") : "unknown");
  }, [state, signedIn]);
  const dot: Dot = state !== "ready" ? "off" : signedIn ? "ok" : "warn";
  return (
    <PrefsRow
      data-main-login={state === "ready" ? (signedIn ? "signed-in" : "signed-out") : state}
      title={
        <span className="flex items-center gap-2">
          <DotMark dot={dot} />
          Your main login
        </span>
      }
      description={
        state === "ready" && check
          ? signedIn
            ? check.detail
            : `Not signed in. ${check.detail}`
          : state === "loading"
            ? "Checking…"
            : "The Claude you already use. Kora could not check it just now."
      }
      control={
        <Button size="xs" variant="outline" onClick={() => void load()} data-main-login-check>
          <RefreshCwIcon /> Check
        </Button>
      }
    >
      <p className="mt-1 max-w-2xl text-[12px] text-muted-foreground">
        The Claude you already use. Add another account below to keep a work and a personal login
        apart. Kora never copies your login and never switches accounts for you.
      </p>
      {state === "ready" && !signedIn ? (
        <div className="mt-3 max-w-2xl space-y-2" data-main-login-signin>
          {check && canLogInFromApp(check) && httpBaseUrl ? (
            <ClaudeLoginButton
              httpBaseUrl={httpBaseUrl}
              onLoggedIn={() => void load()}
              doneText="Signed in. Checking again…"
            />
          ) : null}
          <p className="text-[12px] text-muted-foreground">
            Or run this in {terminalAppName()}, then press Check.
          </p>
          <CopyCommand command="claude auth login" />
        </div>
      ) : null}
    </PrefsRow>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-card px-2.5 py-2 ring-1 ring-border/60">
      <code
        className="min-w-0 flex-1 select-all break-all text-[11.5px] text-foreground"
        data-sign-in-command
      >
        {command}
      </code>
      <Button
        size="xs"
        variant="ghost"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            fail("Could not copy", "Select the command and copy it by hand.");
          }
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function AccountRow({ api, account }: { api: EnginesApi; account: EngineAccountView }) {
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    const r = await api.run({ op: "account.check", name: account.name });
    setBusy(false);
    if (!r.ok) fail("Could not check the account", r.message);
  };
  return (
    <PrefsRow
      data-account-row={account.name}
      title={
        <span className="flex items-center gap-2">
          <DotMark dot={accountDot(account)} />
          {account.label}
        </span>
      }
      description={accountWord(account)}
      control={
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void check()}
            data-account-check
          >
            Check
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={async () => {
              const confirmed = await readLocalApi()?.dialogs.confirm(
                `Remove the Claude account "${account.label}"?\nKora forgets it and deletes its folder (${account.configDir}) if Kora created it. A login saved in your macOS Keychain stays: to sign it out first, run CLAUDE_CONFIG_DIR='${account.configDir}' claude auth logout in Terminal.`,
                { variant: "destructive" },
              );
              if (confirmed === false) return;
              const r = await api.run({ op: "account.remove", name: account.name });
              if (!r.ok) fail("Could not remove the account", r.message);
            }}
          >
            Remove
          </Button>
        </div>
      }
    >
      {account.signIn !== "signed-in" ? (
        <div className="mt-3 max-w-2xl space-y-1.5">
          <p className="text-[12px] text-muted-foreground">
            Run this in {terminalAppName()}, then press Check.
          </p>
          <CopyCommand command={account.signInCommand} />
        </div>
      ) : null}
    </PrefsRow>
  );
}

function AddAccount({ api, onDone }: { api: EnginesApi; onDone: () => void }) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const name = slugify(label);
    if (!name) {
      setError("Give the account a name, like Work.");
      return;
    }
    setBusy(true);
    setError(null);
    const r = await api.run({ op: "account.add", name, label: label.trim() });
    setBusy(false);
    if (!r.ok) setError(r.message);
    else onDone();
  };
  return (
    <PrefsRow
      title="New Claude account"
      description="It starts empty: you sign in to it yourself with the command shown next."
    >
      <form
        className="mt-3 flex max-w-md items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          size="sm"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Work"
          aria-label="Account name"
          data-account-name
        />
        <Button size="xs" type="submit" disabled={busy || !label.trim()} data-account-create>
          Add
        </Button>
        <Button size="xs" type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </form>
      {error ? (
        <p className="mt-2 text-[12px] text-destructive-foreground" role="alert">
          {error}
        </p>
      ) : null}
    </PrefsRow>
  );
}

// ── ACP agents ───────────────────────────────────────────────────────────────────────────────────────────────────
function AcpSection({ api, view }: { api: EnginesApi; view: EnginesView }) {
  const koraOn = useKoraSurfaceOn();
  const [adding, setAdding] = useState(false);
  const [minutes, setMinutes] = useState(String(view.acpIdleMinutes));
  const [showAll, setShowAll] = useState(false);
  // installed (or custom) agents first; the rest of the built-in table waits behind one line
  const ready = view.acp.filter((a) => a.status.available || a.custom || a.status.parked);
  const rest = view.acp.filter((a) => !(a.status.available || a.custom || a.status.parked));
  const shown = showAll ? [...ready, ...rest] : ready;
  const hidden = rest;
  return (
    <PrefsSection
      title="Agents (ACP)"
      data-engines-acp
      headerAction={
        <div className="flex items-center gap-1">
          {view.acp.some((a) => a.status.parked) ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void api.run({ op: "refresh" })}
              data-acp-recheck
            >
              <RefreshCwIcon /> Re-check
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setAdding((v) => !v)}
            data-acp-add-toggle
          >
            <PlusIcon /> Add custom agent
          </Button>
        </div>
      }
    >
      <PrefsRow
        title="Agent Client Protocol"
        description={
          koraOn
            ? "Command-line agents that speak ACP can run a blob. Kora asks before they edit or run anything outside the blob's folders, the same as every other engine."
            : "Command-line agents that speak ACP show up in the composer's model picker, like every other engine."
        }
      />
      {shown.map((a) => (
        <AcpRow key={a.agentId} api={api} agent={a} />
      ))}
      {hidden.length > 0 ? (
        <div className="px-1 py-2">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            data-acp-show-all
            className="text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {showAll
              ? "Hide the agents that are not installed"
              : `${hidden.length} more that are not installed on ${thisComputer()}`}
          </button>
        </div>
      ) : null}
      {adding ? (
        <AddAcp api={api} onDone={() => setAdding(false)} taken={view.acp.map((a) => a.agentId)} />
      ) : null}
      <PrefsRow
        title="Close idle agents after"
        description="An agent process is kept running between messages, then closed to free memory. The conversation is not lost."
        control={
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              inputMode="numeric"
              className="w-16"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value.replace(/\D/g, "").slice(0, 3))}
              aria-label="Idle minutes"
              onBlur={async () => {
                const n = Number(minutes);
                if (!Number.isFinite(n) || n === view.acpIdleMinutes) return;
                const r = await api.run({ op: "acp.idle", minutes: n });
                if (!r.ok) {
                  fail("Could not save", r.message);
                  setMinutes(String(view.acpIdleMinutes));
                }
              }}
            />
            <span className="text-[12.5px] text-muted-foreground">minutes</span>
          </div>
        }
      />
    </PrefsSection>
  );
}

function AcpRow({ api, agent }: { api: EnginesApi; agent: EngineAcpView }) {
  const [open, setOpen] = useState(false);
  const [exe, setExe] = useState(agent.executable ?? "");
  const [args, setArgs] = useState(joinArgs(agent.args));
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<{ names: string[]; error: string | null } | null>(null);
  const save = async () => {
    setBusy(true);
    const r = await api.run({
      op: "acp.save",
      agentId: agent.agentId,
      executable: exe.trim() || null,
      args: parseArgs(args),
    });
    setBusy(false);
    if (!r.ok) fail("Could not save", r.message);
  };
  const discover = async () => {
    setBusy(true);
    const r = await api.run({ op: "acp.models", agentId: agent.agentId });
    setBusy(false);
    if (!r.ok) return fail("Could not list the models", r.message);
    setModels({
      names: (r.value.models ?? []).map((m) => m.name || m.id),
      error: r.value.error ?? null,
    });
  };
  return (
    <PrefsRow
      data-acp-row={agent.agentId}
      title={
        <span className="flex items-center gap-2">
          <DotMark dot={statusDot(agent.status)} />
          {agent.label}
          <span className="rounded-full bg-accent px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            ACP
          </span>
        </span>
      }
      description={statusLine(agent.status)}
      control={
        <Button size="xs" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Done" : "Edit"}
        </Button>
      }
    >
      {open ? (
        <div className="mt-3 max-w-2xl space-y-3">
          <Field label="Path" hint={`Empty = search for \`${agent.command}\` automatically.`}>
            <Input
              size="sm"
              value={exe}
              onChange={(e) => setExe(e.target.value)}
              placeholder={agent.command}
              spellCheck={false}
              aria-label={`${agent.label} path`}
            />
          </Field>
          <Field label="Arguments" hint={`Default: ${joinArgs(agent.defaultArgs) || "none"}`}>
            <Input
              size="sm"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              spellCheck={false}
              aria-label={`${agent.label} arguments`}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button size="xs" disabled={busy} onClick={() => void save()} data-acp-save>
              Save
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !agent.status.available}
              onClick={() => void discover()}
              data-acp-models
            >
              Models
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={async () => {
                const r = await api.run({ op: "acp.remove", agentId: agent.agentId });
                if (!r.ok) fail("Could not remove", r.message);
              }}
            >
              {agent.custom ? "Remove" : "Reset to default"}
            </Button>
          </div>
          {models ? (
            <p className="text-[12px] text-muted-foreground" data-acp-models-result>
              {models.error
                ? models.error
                : models.names.length
                  ? `${models.names.length} models: ${models.names.slice(0, 8).join(", ")}${models.names.length > 8 ? "…" : ""}`
                  : "This agent did not list any models; it uses its own default."}
            </p>
          ) : null}
        </div>
      ) : null}
    </PrefsRow>
  );
}

function AddAcp({ api, onDone, taken }: { api: EnginesApi; onDone: () => void; taken: string[] }) {
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!label.trim() || !command.trim()) {
      setError("A custom agent needs a name and a command.");
      return;
    }
    const id = `acp-${freeSlug(
      label,
      taken.map((t) => t.replace(/^acp-/, "")),
    )}`;
    setBusy(true);
    setError(null);
    const r = await api.run({
      op: "acp.save",
      agentId: id,
      label: label.trim(),
      command: command.trim(),
      args: parseArgs(args),
      env: parseEnv(env),
    });
    setBusy(false);
    if (!r.ok) setError(r.message);
    else onDone();
  };
  return (
    <PrefsRow title="Add a custom agent" description="Any command that speaks ACP over stdio.">
      <form
        className="mt-3 max-w-2xl space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input
              size="sm"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="My agent"
              data-acp-name
            />
          </Field>
          <Field label="Command">
            <Input
              size="sm"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="my-agent or /usr/local/bin/my-agent"
              spellCheck={false}
              data-acp-command
            />
          </Field>
        </div>
        <Field label="Arguments" hint="The arguments that start it in ACP mode, like acp or --acp.">
          <Input
            size="sm"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            spellCheck={false}
            data-acp-args
          />
        </Field>
        <Field
          label="Environment (optional)"
          hint="One NAME=value per line. Do not put secrets here."
        >
          <textarea
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            rows={2}
            spellCheck={false}
            className="w-full rounded-lg bg-background px-2.5 py-1.5 text-[12px] ring-1 ring-border/70 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </Field>
        <div className="flex items-center gap-2">
          <Button size="xs" type="submit" disabled={busy} data-acp-create>
            Add agent
          </Button>
          <Button size="xs" type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
        {error ? (
          <p className="text-[12px] text-destructive-foreground" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </PrefsRow>
  );
}

// ── API endpoints ────────────────────────────────────────────────────────────────────────────────────────────────
function ApiSection({ api, view }: { api: EnginesApi; view: EnginesView }) {
  const koraOn = useKoraSurfaceOn();
  const [adding, setAdding] = useState<null | { preset: string | null }>(null);
  const presets = remainingPresets(view);
  return (
    <PrefsSection
      title="API endpoints"
      data-engines-api
      headerAction={
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setAdding({ preset: null })}
          data-api-add-toggle
        >
          <PlusIcon /> Add endpoint
        </Button>
      }
    >
      <PrefsRow
        title="Bring your own provider"
        description={`Any OpenAI- or Anthropic-compatible endpoint can run ${koraOn ? "a blob" : "a chat"}. Keys are stored securely on ${thisComputer()} and never shown again.`}
      >
        {presets.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5" data-api-presets>
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setAdding({ preset: p.id })}
                data-api-preset={p.id}
                className="rounded-full bg-card px-2.5 py-1 text-[12px] text-foreground ring-1 ring-border/70 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {p.label}
              </button>
            ))}
          </div>
        ) : null}
      </PrefsRow>
      {adding ? (
        <AddApi
          key={adding.preset ?? "custom"}
          api={api}
          view={view}
          preset={adding.preset}
          onDone={() => setAdding(null)}
        />
      ) : null}
      {view.endpoints.map((e) => (
        <ApiRow key={e.id} api={api} endpoint={e} />
      ))}
    </PrefsSection>
  );
}

function AddApi({
  api,
  view,
  preset,
  onDone,
}: {
  api: EnginesApi;
  view: EnginesView;
  preset: string | null;
  onDone: () => void;
}) {
  const p = view.presets.find((x) => x.id === preset) ?? null;
  const [label, setLabel] = useState(p?.label ?? "");
  const [protocol, setProtocol] = useState<"openai" | "anthropic">(p?.protocol ?? "openai");
  const [baseUrl, setBaseUrl] = useState(p?.baseUrl ?? "");
  const [model, setModel] = useState(p?.defaultModel ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!label.trim() || !baseUrl.trim()) {
      setError("An endpoint needs a name and a base URL.");
      return;
    }
    const id =
      p?.id ??
      freeSlug(
        label,
        view.endpoints.map((e) => e.id),
      );
    setBusy(true);
    setError(null);
    const r = await api.run({
      op: "api.save",
      id,
      label: label.trim(),
      protocol,
      baseUrl: baseUrl.trim(),
      ...(model.trim() ? { defaultModel: model.trim() } : {}),
    });
    setBusy(false);
    if (!r.ok) setError(r.message);
    else onDone();
  };
  return (
    <PrefsRow
      title={p ? `Add ${p.label}` : "Add an endpoint"}
      description="You add the key next, on its row."
    >
      <form
        className="mt-3 max-w-2xl space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input
              size="sm"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="My provider"
              data-api-name
            />
          </Field>
          <Field label="Protocol">
            <select
              value={protocol}
              onChange={(e) => setProtocol(e.target.value === "anthropic" ? "anthropic" : "openai")}
              className="h-7.5 w-full rounded-lg bg-background px-2 text-[12.5px] ring-1 ring-border/70 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-api-protocol
            >
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic-compatible</option>
            </select>
          </Field>
        </div>
        <Field
          label="Base URL"
          hint="Remote providers must use https://. Local servers (LM Studio, Ollama) may use http://localhost."
        >
          <Input
            size="sm"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            data-api-url
          />
        </Field>
        <Field label="Default model (optional)">
          <Input
            size="sm"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            spellCheck={false}
            data-api-model
          />
        </Field>
        <div className="flex items-center gap-2">
          <Button size="xs" type="submit" disabled={busy} data-api-create>
            Add endpoint
          </Button>
          <Button size="xs" type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
        {error ? (
          <p className="text-[12px] text-destructive-foreground" role="alert" data-api-error>
            {error}
          </p>
        ) : null}
      </form>
    </PrefsRow>
  );
}

export function ApiRow({ api, endpoint }: { api: EnginesApi; endpoint: EngineApiView }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<null | "save" | "test" | "models">(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<string[] | null>(null);

  // A key is saved only after it passed Test (live QA #4: a wrong key was stored first and discovered later). A key that fails
  // is not stored; "Save anyway" keeps it, and says it is unverified.
  const [rejected, setRejected] = useState(false);
  const store = async (verified: boolean) => {
    setBusy("save");
    const r = await api.run({ op: "api.setKey", id: endpoint.id, key: key.trim() });
    setBusy(null);
    if (!r.ok) return setResult({ ok: false, text: r.message });
    setKey("");
    setRejected(false);
    setResult({ ok: true, text: verified ? "Key checked and saved." : "Key saved, not verified." });
  };
  const saveKey = async () => {
    setBusy("test");
    setResult(null);
    setRejected(false);
    const t = await api.run({ op: "api.test", id: endpoint.id, key: key.trim() });
    setBusy(null);
    if (!t.ok) {
      setRejected(true);
      return setResult({
        ok: false,
        text: `Could not check that key (${t.message}). It was not saved.`,
      });
    }
    const outcome = t.value.test;
    if (!outcome?.ok) {
      setRejected(true);
      return setResult({
        ok: false,
        text: `${outcome ? testLine(outcome) : "No answer."} The key was not saved.`,
      });
    }
    await store(true);
  };
  const test = async () => {
    setBusy("test");
    setResult(null);
    const r = await api.run({
      op: "api.test",
      id: endpoint.id,
      ...(key.trim() ? { key: key.trim() } : {}),
    });
    setBusy(null);
    if (!r.ok) return setResult({ ok: false, text: r.message });
    const t = r.value.test;
    setResult(t ? { ok: t.ok, text: testLine(t) } : { ok: false, text: "No answer." });
  };
  const listModels = async () => {
    setBusy("models");
    const r = await api.run({ op: "api.models", id: endpoint.id });
    setBusy(null);
    if (!r.ok) return setResult({ ok: false, text: r.message });
    setModels((r.value.models ?? []).map((m) => m.id));
  };

  return (
    <PrefsRow
      data-api-row={endpoint.id}
      title={
        <span className="flex items-center gap-2">
          <DotMark dot={statusDot(endpoint.status)} />
          {endpoint.label}
          <span className="rounded-full bg-accent px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            API
          </span>
        </span>
      }
      description={
        endpointNeedsKey(endpoint)
          ? "Needs an API key."
          : `${endpoint.baseUrl}${endpoint.hasKey ? " · key saved" : ""}`
      }
      control={
        <Button
          size="xs"
          variant="ghost"
          onClick={async () => {
            const r = await api.run({ op: "api.remove", id: endpoint.id });
            if (!r.ok) fail("Could not remove", r.message);
          }}
          data-api-remove
        >
          Remove
        </Button>
      }
    >
      <div className="mt-3 max-w-2xl space-y-2">
        {
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                endpoint.hasKey
                  ? "Saved. Paste a new key to replace it"
                  : endpoint.requiresKey
                    ? "API key"
                    : "API key (optional for a local server)"
              }
              aria-label={`${endpoint.label} API key`}
              data-api-key
            />
            <Button
              size="xs"
              disabled={busy !== null || !key.trim()}
              onClick={() => void saveKey()}
              data-api-key-save
            >
              {busy === "test" && key.trim() ? "Checking…" : "Test and save"}
            </Button>
            {rejected && key.trim() ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void store(false)}
                data-api-key-save-anyway
              >
                Save anyway
              </Button>
            ) : null}
            {endpoint.hasKey ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={async () => {
                  const r = await api.run({ op: "api.clearKey", id: endpoint.id });
                  if (!r.ok) fail("Could not remove the key", r.message);
                  else setResult(null);
                }}
              >
                Remove key
              </Button>
            ) : null}
          </div>
        }
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void test()}
            data-api-test
          >
            {busy === "test" ? "Testing…" : "Test"}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void listModels()}
            data-api-models
          >
            {busy === "models" ? "Loading…" : "Models"}
          </Button>
          <span className="text-[11.5px] text-muted-foreground">
            Test only checks the key and lists models. It sends no message.
          </span>
        </div>
        {result ? (
          <p
            className={cn(
              "text-[12.5px]",
              result.ok ? "text-foreground" : "text-destructive-foreground",
            )}
            role="status"
            data-api-result
          >
            {result.text}
          </p>
        ) : null}
        {models ? (
          <p className="text-[12px] text-muted-foreground" data-api-models-result>
            {models.length
              ? `${models.length} models: ${models.slice(0, 8).join(", ")}${models.length > 8 ? "…" : ""}`
              : "No models listed."}
          </p>
        ) : null}
      </div>
    </PrefsRow>
  );
}
