// Pure helpers for Settings › Extensions (no React, no RPC).
import type { ExtensionAgentId, ExtensionKeyValue, ExtensionServer } from "@kora/contracts";

export const ALL_AGENTS: readonly ExtensionAgentId[] = [
  "claude",
  "codex",
  "opencode",
  "antigravity",
];
export const AGENT_SHORT: Record<ExtensionAgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  antigravity: "Antigravity",
};

/** "All agents", or the names in order ("Claude Code, Codex"). */
export function agentsSummary(agents: readonly ExtensionAgentId[]): string {
  const set = new Set(agents);
  if (ALL_AGENTS.every((a) => set.has(a))) return "All agents";
  if (set.size === 0) return "No agent";
  return ALL_AGENTS.filter((a) => set.has(a))
    .map((a) => AGENT_SHORT[a])
    .join(", ");
}

/** What the row shows under the name: the command line or the URL, shortened. */
export function targetLine(
  s: Pick<ExtensionServer, "transport" | "command" | "args" | "url">,
): string {
  const full = s.transport === "http" ? (s.url ?? "") : [s.command ?? "", ...s.args].join(" ");
  return full.length > 96 ? `${full.slice(0, 95)}…` : full;
}

export interface Draft {
  server: ExtensionServer;
  /** Name the stored entry had (edits/renames); null for a new one. */
  previousName: string | null;
  /** New values typed for secret entries, by slot `env:KEY` / `header:Name`. */
  secretValues: Record<string, string>;
}

export const blankServer = (transport: "stdio" | "http" = "stdio"): ExtensionServer => ({
  name: "",
  transport,
  command: transport === "stdio" ? "" : null,
  args: [],
  env: [],
  url: transport === "http" ? "" : null,
  headers: [],
  enabled: true,
  agents: [...ALL_AGENTS],
  workers: false,
  folders: [],
  source: "manual",
});

/** A parsed or imported server as a draft: literal values marked secret move into `secretValues` (typed fields). */
export function draftFrom(server: ExtensionServer, previousName: string | null = null): Draft {
  const secretValues: Record<string, string> = {};
  const strip = (list: readonly ExtensionKeyValue[], kind: "env" | "header") =>
    list.map((kv) => {
      if (kv.secret && kv.value !== null) {
        secretValues[`${kind}:${kv.key}`] = kv.value;
        return { ...kv, value: null };
      }
      return kv;
    });
  return {
    server: { ...server, env: strip(server.env, "env"), headers: strip(server.headers, "header") },
    previousName,
    secretValues,
  };
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

/** Problems to show before Save is offered (the daemon checks again). */
export function draftProblems(d: Draft, existingNames: readonly string[]): string[] {
  const s = d.server;
  const out: string[] = [];
  if (!NAME.test(s.name)) out.push("Name: letters, digits, _ or -, up to 48.");
  else if (["kora", "kora_fleet", "kora_blobs", "kora_team"].includes(s.name.toLowerCase()))
    out.push(`"${s.name}" is reserved.`);
  else if (
    existingNames.some((n) => n.toLowerCase() === s.name.toLowerCase()) &&
    s.name.toLowerCase() !== (d.previousName ?? "").toLowerCase()
  )
    out.push(`You already have "${s.name}".`);
  if (s.transport === "stdio" && !(s.command ?? "").trim())
    out.push("Enter the command that starts it.");
  if (s.transport === "http" && !/^https?:\/\/\S+$/.test(s.url ?? ""))
    out.push("Enter the server's URL.");
  if (s.agents.length === 0) out.push("Pick at least one agent.");
  for (const [kind, list] of [
    ["env", s.env],
    ["header", s.headers],
  ] as const) {
    for (const kv of list) {
      if (!kv.key.trim()) continue;
      if (
        kv.secret &&
        kv.value === null &&
        !d.secretValues[`${kind}:${kv.key}`] &&
        d.previousName === null
      )
        out.push(`Enter a value for ${kv.key}.`);
    }
  }
  return out;
}

/** The save input: secret values travel separately and only when typed. */
export function saveInputOf(d: Draft) {
  const secrets = Object.entries(d.secretValues)
    .filter(([, value]) => value.trim() !== "")
    .map(([slot, value]) => ({ slot, value: value.trim() }));
  const clean = (list: readonly ExtensionKeyValue[]) => list.filter((kv) => kv.key.trim() !== "");
  return {
    server: {
      ...d.server,
      name: d.server.name.trim(),
      env: clean(d.server.env),
      headers: clean(d.server.headers),
    },
    secrets,
    previousName: d.previousName,
  };
}

/** Words of a command line (quotes respected), for the args editor. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let had = false;
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      had = true;
    } else if (/\s/.test(c)) {
      if (cur || had) out.push(cur);
      cur = "";
      had = false;
    } else cur += c;
  }
  if (cur || had) out.push(cur);
  return out;
}

export const joinCommandLine = (words: readonly string[]) =>
  words.map((w) => (w === "" || /[\s"']/.test(w) ? JSON.stringify(w) : w)).join(" ");
