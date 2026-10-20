// Settings › Extensions: MCP servers and skills, added once, for every agent.
//   Add          paste anything a server's README shows (JSON in any agent's shape, Codex TOML, a URL, a command) → review
//   Your servers on/off, which agents, workers too, Test (starts it and lists its tools), Edit, Remove
//   Catalog      a short checked list; asks only for what the server needs
//   Found        servers already configured in Claude Code / Codex / OpenCode / Antigravity, one click to import
//   Project      a repo's shared .kora/extensions.json: nothing runs until you allow each server (and again if it changes)
//   Skills       a folder or a git URL; linked into each agent's skills folder
import type {
  ExtensionAgentId,
  ExtensionCatalogEntry,
  ExtensionKeyValue,
  ExtensionServer,
  ExtensionTestResult,
} from "@kora/contracts";
import { CheckIcon, ChevronDownIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/util/utils";
import { usePrefsProjectGroups } from "../../prefs/usePrefsProjectGroups";
import { PrefsPageContainer, PrefsRow, PrefsSection } from "../../prefs/prefsLayout";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";
import { toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { useExtensionsApi, type ExtensionsApi } from "./extensionsApi";
import {
  AGENT_SHORT,
  ALL_AGENTS,
  agentsSummary,
  blankServer,
  draftFrom,
  draftProblems,
  joinCommandLine,
  saveInputOf,
  splitCommandLine,
  targetLine,
  type Draft,
} from "./extensionsModel";

const note = (title: string, type: "success" | "error" = "success") =>
  toastManager.add({ title, type });

function AgentChips(props: {
  value: readonly ExtensionAgentId[];
  onChange: (next: ExtensionAgentId[]) => void;
}) {
  return (
    <div role="group" aria-label="Agents" className="flex flex-wrap gap-1">
      {ALL_AGENTS.map((a) => {
        const on = props.value.includes(a);
        return (
          <button
            key={a}
            type="button"
            aria-pressed={on}
            onClick={() =>
              props.onChange(on ? props.value.filter((x) => x !== a) : [...props.value, a])
            }
            className={cn(
              "h-6 cursor-pointer rounded-full border px-2.5 text-[11px] transition-colors",
              on
                ? "border-foreground/40 bg-foreground/10 text-foreground"
                : "border-dashed border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {AGENT_SHORT[a]}
          </button>
        );
      })}
    </div>
  );
}

function TestLine({ result }: { result: ExtensionTestResult | "running" | null }) {
  if (!result) return null;
  if (result === "running")
    return <p className="text-[12px] text-muted-foreground">Starting it…</p>;
  if (result.ok) {
    return (
      <p className="text-[12px] text-muted-foreground">
        <CheckIcon className="mr-1 inline size-3" aria-hidden />
        Answers with {result.tools.length} tool{result.tools.length === 1 ? "" : "s"} in{" "}
        {(result.ms / 1000).toFixed(1)} s
        {result.tools.length
          ? `: ${result.tools.slice(0, 10).join(", ")}${result.tools.length > 10 ? ", …" : ""}`
          : ""}
      </p>
    );
  }
  return (
    <div className="space-y-1 text-[12px]">
      <p className="text-destructive-foreground">
        <XIcon className="mr-1 inline size-3" aria-hidden />
        {result.error}
      </p>
      {result.stderr ? (
        <pre className="max-h-32 overflow-auto rounded-md bg-foreground/5 p-2 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
          {result.stderr}
        </pre>
      ) : null}
    </div>
  );
}

function KeyValues(props: {
  label: string;
  kind: "env" | "header";
  list: readonly ExtensionKeyValue[];
  secretValues: Record<string, string>;
  onChange: (list: ExtensionKeyValue[], secretValues: Record<string, string>) => void;
}) {
  const { list, kind, secretValues } = props;
  const set = (i: number, next: Partial<ExtensionKeyValue>) =>
    props.onChange(
      list.map((kv, k) => (k === i ? { ...kv, ...next } : kv)),
      secretValues,
    );
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium">{props.label}</span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            props.onChange([...list, { key: "", value: "", secret: false }], secretValues)
          }
        >
          <PlusIcon /> Add
        </Button>
      </div>
      {list.map((kv, i) => {
        const slot = `${kind}:${kv.key}`;
        return (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              className="w-44 font-mono text-[12px]"
              placeholder={kind === "env" ? "NAME" : "Header-Name"}
              value={kv.key}
              onChange={(e) => set(i, { key: e.target.value })}
            />
            {kv.secret ? (
              <Input
                className="flex-1 font-mono text-[12px]"
                type="password"
                autoComplete="off"
                placeholder={
                  kv.value === null && !secretValues[slot]
                    ? "saved in the keychain (type to replace)"
                    : "value"
                }
                value={secretValues[slot] ?? ""}
                onChange={(e) =>
                  props.onChange([...list], { ...secretValues, [slot]: e.target.value })
                }
              />
            ) : (
              <Input
                className="flex-1 font-mono text-[12px]"
                placeholder="value"
                value={kv.value ?? ""}
                onChange={(e) => set(i, { value: e.target.value })}
              />
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Switch
                      size="sm"
                      checked={kv.secret}
                      onCheckedChange={(on) =>
                        set(i, { secret: on, value: on ? null : (secretValues[slot] ?? "") })
                      }
                    />
                    Secret
                  </label>
                }
              />
              <TooltipPopup side="top">Kept in the macOS Keychain, never in a file</TooltipPopup>
            </Tooltip>
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Remove ${kv.key || "entry"}`}
              onClick={() =>
                props.onChange(
                  list.filter((_, k) => k !== i),
                  secretValues,
                )
              }
            >
              <XIcon />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function ServerEditor(props: {
  api: ExtensionsApi;
  draft: Draft;
  existing: readonly string[];
  onDone: () => void;
  submitLabel?: string;
}) {
  const [d, setD] = useState(props.draft);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<ExtensionTestResult | "running" | null>(null);
  const problems = draftProblems(d, props.existing);
  const s = d.server;
  const patch = (next: Partial<ExtensionServer>) => setD({ ...d, server: { ...s, ...next } });

  const runTest = async () => {
    setTest("running");
    const input = saveInputOf(d);
    const r = await props.api.test({ name: null, draft: input.server, secrets: input.secrets });
    setTest(
      r.ok
        ? r.value
        : {
            ok: false,
            ms: 0,
            tools: [],
            serverName: null,
            serverVersion: null,
            error: r.message,
            stderr: null,
          },
    );
  };
  const save = async () => {
    setBusy(true);
    const r = await props.api.save(saveInputOf(d));
    setBusy(false);
    if (!r.ok) return note(r.message, "error");
    note(
      `${r.value.name} is on for ${agentsSummary(r.value.agents).toLowerCase()}. New chats pick it up.`,
    );
    props.onDone();
  };

  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="block text-[12px] font-medium">Name</span>
          <Input
            className="w-48"
            value={s.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="github"
          />
        </label>
        <div className="space-y-1">
          <span className="block text-[12px] font-medium">Kind</span>
          <div className="flex gap-1">
            {(["stdio", "http"] as const).map((t) => (
              <Button
                key={t}
                size="xs"
                variant={s.transport === t ? "default" : "outline"}
                onClick={() =>
                  patch({
                    transport: t,
                    command: t === "stdio" ? (s.command ?? "") : null,
                    url: t === "http" ? (s.url ?? "") : null,
                  })
                }
              >
                {t === "stdio" ? "Local command" : "Remote URL"}
              </Button>
            ))}
          </div>
        </div>
      </div>
      {s.transport === "stdio" ? (
        <label className="block space-y-1">
          <span className="block text-[12px] font-medium">Command</span>
          <Input
            className="font-mono text-[12px]"
            value={joinCommandLine(
              [s.command ?? "", ...s.args].filter((w, i) => i > 0 || w !== ""),
            )}
            onChange={(e) => {
              const [command = "", ...args] = splitCommandLine(e.target.value);
              patch({ command, args });
            }}
            placeholder="npx -y @modelcontextprotocol/server-memory"
          />
        </label>
      ) : (
        <label className="block space-y-1">
          <span className="block text-[12px] font-medium">URL</span>
          <Input
            className="font-mono text-[12px]"
            value={s.url ?? ""}
            onChange={(e) => patch({ url: e.target.value })}
            placeholder="https://example.com/mcp"
          />
        </label>
      )}
      <KeyValues
        label={s.transport === "stdio" ? "Environment" : "Headers"}
        kind={s.transport === "stdio" ? "env" : "header"}
        list={s.transport === "stdio" ? s.env : s.headers}
        secretValues={d.secretValues}
        onChange={(list, secretValues) =>
          setD({
            ...d,
            secretValues,
            server: { ...s, ...(s.transport === "stdio" ? { env: list } : { headers: list }) },
          })
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <AgentChips value={s.agents} onChange={(agents) => patch({ agents })} />
        <label className="flex items-center gap-2 text-[12px]">
          <Switch size="sm" checked={s.workers} onCheckedChange={(workers) => patch({ workers })} />
          Also for worker panes
        </label>
      </div>
      {problems.length ? <p className="text-[12px] text-muted-foreground">{problems[0]}</p> : null}
      <TestLine result={test} />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={props.onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={problems.length > 0 || test === "running"}
          onClick={() => void runTest()}
        >
          Test
        </Button>
        <Button size="sm" disabled={problems.length > 0 || busy} onClick={() => void save()}>
          {props.submitLabel ?? "Save"}
        </Button>
      </div>
    </div>
  );
}

function AddFromText(props: { api: ExtensionsApi; existing: readonly string[] }) {
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [manual, setManual] = useState(false);
  const read = async () => {
    const r = await props.api.parse(text);
    if (!r.ok) return note(r.message, "error");
    setWarnings([...r.value.warnings]);
    setDrafts(r.value.servers.map((s) => draftFrom(s)));
  };
  if (manual)
    return (
      <ServerEditor
        api={props.api}
        draft={{ server: blankServer(), previousName: null, secretValues: {} }}
        existing={props.existing}
        onDone={() => setManual(false)}
        submitLabel="Add"
      />
    );
  return (
    <div className="space-y-3 px-4 py-3">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="font-mono text-[12px]"
        placeholder={
          'Paste what the server\'s README shows: {"mcpServers": …}, a command (npx -y …), a URL, or a "claude mcp add …" line'
        }
        aria-label="Server config to add"
      />
      <div className="flex items-center justify-between gap-2">
        <Button size="xs" variant="ghost" onClick={() => setManual(true)}>
          Fill it in by hand
        </Button>
        <Button size="sm" disabled={!text.trim()} onClick={() => void read()}>
          Read it
        </Button>
      </div>
      {warnings.map((w) => (
        <p key={w} className="text-[12px] text-muted-foreground">
          {w}
        </p>
      ))}
      {drafts.map((d, i) => (
        <div key={`${d.server.name}-${i}`} className="rounded-lg border border-border/60">
          <ServerEditor
            api={props.api}
            draft={d}
            existing={props.existing}
            submitLabel="Add"
            onDone={() => {
              const rest = drafts.filter((_, k) => k !== i);
              setDrafts(rest);
              if (rest.length === 0) setText("");
            }}
          />
        </div>
      ))}
    </div>
  );
}

function ServerRow(props: {
  api: ExtensionsApi;
  server: ExtensionServer;
  existing: readonly string[];
}) {
  const { server: s, api } = props;
  const [editing, setEditing] = useState(false);
  const [test, setTest] = useState<ExtensionTestResult | "running" | null>(null);
  if (editing)
    return (
      <ServerEditor
        api={api}
        draft={draftFrom(s, s.name)}
        existing={props.existing}
        onDone={() => setEditing(false)}
      />
    );
  return (
    <PrefsRow
      title={
        <span className="flex items-center gap-2">
          <span className="font-mono">{s.name}</span>
          <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">
            {s.transport === "http" ? "remote" : "local"}
          </span>
          {s.workers ? (
            <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">
              workers too
            </span>
          ) : null}
          {s.source === "project" ? (
            <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">
              project
            </span>
          ) : null}
        </span>
      }
      description={
        <span className="space-y-1">
          <span className="block font-mono text-[11px]">{targetLine(s)}</span>
          <span className="block">
            {agentsSummary(s.agents)}
            {s.folders.length ? ` · only in ${s.folders.join(", ")}` : ""}
          </span>
          <TestLine result={test} />
        </span>
      }
      control={
        <span className="flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={async () => {
              setTest("running");
              const r = await api.test({ name: s.name, draft: null, secrets: [] });
              setTest(
                r.ok
                  ? r.value
                  : {
                      ok: false,
                      ms: 0,
                      tools: [],
                      serverName: null,
                      serverVersion: null,
                      error: r.message,
                      stderr: null,
                    },
              );
            }}
          >
            Test
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Remove ${s.name}`}
            onClick={async () => {
              const r = await api.remove(s.name);
              note(r.ok ? `Removed ${s.name}.` : r.message, r.ok ? "success" : "error");
            }}
          >
            <Trash2Icon />
          </Button>
          <Switch
            aria-label={`${s.name} on`}
            checked={s.enabled}
            onCheckedChange={async (on) => {
              const r = await api.setEnabled(s.name, on);
              if (!r.ok) note(r.message, "error");
            }}
          />
        </span>
      }
    />
  );
}

function CatalogCard(props: {
  api: ExtensionsApi;
  entry: ExtensionCatalogEntry;
  onAdded: () => void;
}) {
  const { entry, api } = props;
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [agents, setAgents] = useState<ExtensionAgentId[]>([...ALL_AGENTS]);
  const [workers, setWorkers] = useState(false);
  const [busy, setBusy] = useState(false);
  const missing = entry.params.find((p) => p.required && !(answers[p.key] ?? "").trim());
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <a
            href={entry.homepage}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] font-medium hover:underline"
          >
            {entry.title}
          </a>
          <p className="text-[12px] text-muted-foreground">{entry.description}</p>
          {entry.needs ? (
            <p className="text-[11px] text-muted-foreground/80">
              Needs {entry.needs === "node" ? "Node.js (npx)" : "uv (uvx)"}
            </p>
          ) : null}
        </div>
        {entry.added ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">Added</span>
        ) : (
          <Button size="xs" variant="outline" onClick={() => setOpen(!open)}>
            {open ? "Close" : "Add"}
          </Button>
        )}
      </div>
      {open ? (
        <div className="mt-3 space-y-2">
          {entry.params.map((p) => (
            <label key={p.key} className="block space-y-1">
              <span className="block text-[12px]">
                {p.label}
                {p.required ? "" : " (optional)"}
              </span>
              <Input
                type={p.secret ? "password" : "text"}
                autoComplete="off"
                className="font-mono text-[12px]"
                placeholder={p.placeholder ?? ""}
                value={answers[p.key] ?? ""}
                onChange={(e) => setAnswers({ ...answers, [p.key]: e.target.value })}
              />
              {p.help ? (
                <span className="block text-[11px] text-muted-foreground">{p.help}</span>
              ) : null}
            </label>
          ))}
          <AgentChips value={agents} onChange={setAgents} />
          <label className="flex items-center gap-2 text-[12px]">
            <Switch size="sm" checked={workers} onCheckedChange={setWorkers} />
            Also for worker panes
          </label>
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!!missing || agents.length === 0 || busy}
              onClick={async () => {
                setBusy(true);
                const r = await api.addFromCatalog({ id: entry.id, answers, agents, workers });
                setBusy(false);
                if (!r.ok) return note(r.message, "error");
                note(`${entry.title} added.`);
                setOpen(false);
                props.onAdded();
              }}
            >
              Add {entry.title}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Disclosure(props: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  count?: number;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left text-[13px]"
      >
        <ChevronDownIcon
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            open ? "" : "-rotate-90",
          )}
          aria-hidden
        />
        {props.title}
        {props.count ? (
          <span className="text-[11px] text-muted-foreground">{props.count}</span>
        ) : null}
      </button>
      {open ? <div className="px-4 pb-3">{props.children}</div> : null}
    </div>
  );
}

function useAsync<T>(
  load: () => Promise<{ ok: true; value: T } | { ok: false; message: string }>,
  deps: unknown[],
) {
  const [value, setValue] = useState<T | null>(null);
  const reload = useCallback(async () => {
    const r = await load();
    if (r.ok) setValue(r.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { value, reload };
}

function ProjectSecretInput(props: { label: string; onSave: (value: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  return (
    <span className="flex items-center gap-1.5">
      <Input
        type="password"
        autoComplete="off"
        className="h-7 w-64 font-mono text-[12px]"
        placeholder={`Value for ${props.label}`}
        aria-label={`Value for ${props.label}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        size="xs"
        variant="outline"
        disabled={!value.trim()}
        onClick={() => void props.onSave(value.trim()).then(() => setValue(""))}
      >
        Save
      </Button>
    </span>
  );
}

function ProjectServers(props: { api: ExtensionsApi }) {
  const groups = usePrefsProjectGroups();
  const roots = useMemo(
    () => [
      ...new Set(
        groups
          .map((g) => g.memberProjects[0]?.workspaceRoot ?? g.workspaceRoot ?? "")
          .filter(Boolean),
      ),
    ],
    [groups],
  );
  const { value, reload } = useAsync(async () => {
    const found = await Promise.all(
      roots.map(async (root) => ({ root, r: await props.api.project(root) })),
    );
    return {
      ok: true as const,
      value: found
        .filter((f) => f.r.ok && f.r.value.servers.length > 0)
        .map((f) => ({ root: f.root, servers: f.r.ok ? f.r.value.servers : [] })),
    };
  }, [roots.join("\n")]);
  if (!value || value.length === 0) return null;
  return (
    <PrefsSection title="Shared by your projects" id="extensions-project">
      <p className="px-4 py-2 text-[12px] text-muted-foreground">
        A repository can share servers in <code>.kora/extensions.json</code>. Nothing in it runs
        until you allow it here, and a changed entry needs allowing again. Only in folders you
        trust.
      </p>
      {value.flatMap(({ root, servers }) =>
        servers.map(({ server, approved, missingSecrets }) => (
          <PrefsRow
            key={`${root}:${server.name}`}
            title={<span className="font-mono">{server.name}</span>}
            description={
              <span className="space-y-1">
                <span className="block font-mono text-[11px]">{`${root} · ${targetLine(server)}`}</span>
                {missingSecrets.map((label) => (
                  <ProjectSecretInput
                    key={label}
                    label={label}
                    onSave={async (value) => {
                      const r = await props.api.setProjectSecret(label, value);
                      if (!r.ok) note(r.message, "error");
                      void reload();
                    }}
                  />
                ))}
              </span>
            }
            control={
              <Button
                size="xs"
                variant={approved ? "ghost" : "outline"}
                onClick={async () => {
                  const r = await props.api.projectApprove(root, server.name, !approved);
                  if (!r.ok) note(r.message, "error");
                  void reload();
                }}
              >
                {approved ? "Revoke" : "Allow"}
              </Button>
            }
          />
        )),
      )}
    </PrefsSection>
  );
}

function SkillsSection(props: { api: ExtensionsApi }) {
  const { api } = props;
  const [source, setSource] = useState("");
  const [agents, setAgents] = useState<ExtensionAgentId[]>([...ALL_AGENTS]);
  const [busy, setBusy] = useState(false);
  const skills = api.view?.skills ?? [];
  return (
    <PrefsSection title="Skills" id="extensions-skills">
      <div className="space-y-2 px-4 py-3">
        <p className="text-[12px] text-muted-foreground">
          A skill is a folder with a SKILL.md. Kora keeps a copy and links it into each agent&apos;s
          skills folder; a skill of yours with the same name is never replaced.
        </p>
        <div className="flex gap-2">
          <Input
            className="flex-1 font-mono text-[12px]"
            placeholder="~/skills/my-skill, or https://github.com/owner/skills"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            aria-label="Skill folder or git URL"
          />
          <Button
            size="sm"
            disabled={!source.trim() || busy || agents.length === 0}
            onClick={async () => {
              setBusy(true);
              const r = await api.skillAdd(source.trim(), agents);
              setBusy(false);
              if (!r.ok) return note(r.message, "error");
              note(
                `Installed ${r.value.installed.map((k) => k.name).join(", ") || "nothing"}${r.value.skipped.length ? `; skipped ${r.value.skipped.map((k) => k.name).join(", ")}` : ""}.`,
              );
              setSource("");
            }}
          >
            Install
          </Button>
        </div>
        <AgentChips value={agents} onChange={setAgents} />
      </div>
      {skills.map((k) => (
        <PrefsRow
          key={k.name}
          title={<span className="font-mono">{k.name}</span>}
          description={`${k.description || "No description"} · linked for ${k.linkedFor.length ? agentsSummary(k.linkedFor).toLowerCase() : "no agent yet"}`}
          control={
            <span className="flex items-center gap-1">
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Remove ${k.name}`}
                onClick={async () => {
                  const r = await api.skillRemove(k.name);
                  if (!r.ok) note(r.message, "error");
                }}
              >
                <Trash2Icon />
              </Button>
              <Switch
                aria-label={`${k.name} on`}
                checked={k.enabled}
                onCheckedChange={async (on) => {
                  const r = await api.skillSetEnabled(k.name, on);
                  if (!r.ok) note(r.message, "error");
                }}
              />
            </span>
          }
        />
      ))}
    </PrefsSection>
  );
}

export function ExtensionsSettings({ anchorId }: { anchorId: string }) {
  const api = useExtensionsApi();
  const servers = api.view?.servers ?? [];
  const names = servers.map((s) => s.name);
  const catalog = useAsync(() => api.catalog(), [api.view]);
  const found = useAsync(() => api.discover(), [api.view]);
  const newFound = (found.value?.items ?? []).filter((i) => !i.alreadyAdded);

  return (
    <PrefsPageContainer>
      <PrefsSection title="MCP servers" id={anchorId}>
        <p className="px-4 py-2 text-[12px] text-muted-foreground">
          Add a server once: Claude Code, Codex, OpenCode and Antigravity each get it in their own
          format, in chats and (if you say so) in worker panes. Secret values go to the macOS
          Keychain, never into a file.
        </p>
        <Disclosure title="Add a server" defaultOpen={servers.length === 0}>
          <AddFromText api={api} existing={names} />
        </Disclosure>
        {api.error ? (
          <p className="px-4 py-2 text-[12px] text-destructive-foreground">{api.error}</p>
        ) : null}
        {servers.map((s) => (
          <ServerRow key={s.name} api={api} server={s} existing={names} />
        ))}
        {api.view && servers.length === 0 ? (
          <p className="px-4 py-3 text-[12px] text-muted-foreground">
            No servers yet. Paste one above, pick one below, or import what your agents already
            have.
          </p>
        ) : null}
      </PrefsSection>

      {newFound.length ? (
        <PrefsSection title="Already in your agents" id="extensions-found">
          <p className="px-4 py-2 text-[12px] text-muted-foreground">
            These are configured in an agent&apos;s own settings. Import them to give them to every
            agent.
          </p>
          {newFound.map((item) => (
            <PrefsRow
              key={item.server.name}
              title={<span className="font-mono">{item.server.name}</span>}
              description={
                <span className="font-mono text-[11px]">{`${targetLine(item.server)} · in ${agentsSummary(item.foundIn)}`}</span>
              }
              control={
                <Button
                  size="xs"
                  variant="outline"
                  onClick={async () => {
                    const d = draftFrom(item.server);
                    const r = await api.save(saveInputOf(d));
                    note(
                      r.ok ? `Imported ${item.server.name}.` : r.message,
                      r.ok ? "success" : "error",
                    );
                    void found.reload();
                  }}
                >
                  Import
                </Button>
              }
            />
          ))}
        </PrefsSection>
      ) : null}

      <PrefsSection title="Catalog" id="extensions-catalog">
        <div className="grid gap-2 px-4 py-3 sm:grid-cols-2">
          {(catalog.value?.entries ?? []).map((e) => (
            <CatalogCard key={e.id} api={api} entry={e} onAdded={() => void catalog.reload()} />
          ))}
        </div>
      </PrefsSection>

      <ProjectServers api={api} />
      <SkillsSection api={api} />

      <PrefsSection title="How each agent gets them" id="extensions-delivery">
        {(api.view?.agents ?? []).map((a) => (
          <PrefsRow key={a.id} title={a.label} description={a.delivery} />
        ))}
        <p className="px-4 py-2 text-[12px] text-muted-foreground">
          From a terminal: <code>kora ext add</code>, <code>kora ext import</code>,{" "}
          <code>kora ext catalog</code>.
        </p>
      </PrefsSection>
    </PrefsPageContainer>
  );
}
