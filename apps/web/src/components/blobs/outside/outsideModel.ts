// Pure helpers for the Outside access page: the config snippets each client needs, and the plain words for the log.
import type { OutsideAuditWire, OutsideSetupWire } from "./outsideApi";

export type ClientKind = "claude-desktop" | "cursor" | "claude-code" | "codex";

export const CLIENTS: ReadonlyArray<{ kind: ClientKind; label: string; where: string }> = [
  {
    kind: "claude-desktop",
    label: "Claude Desktop",
    where: "Settings, Developer, Edit config (claude_desktop_config.json)",
  },
  { kind: "cursor", label: "Cursor", where: "~/.cursor/mcp.json (or Settings, MCP)" },
  { kind: "claude-code", label: "Claude Code", where: "Run this once in a terminal" },
  { kind: "codex", label: "Codex", where: "~/.codex/config.toml" },
];

export const TOKEN_PLACEHOLDER = "PASTE_YOUR_TOKEN_HERE";

const q = (s: string) => JSON.stringify(s);
const shell = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The exact text to paste for one client. `token` is the just-created secret, else a placeholder. */
export function snippetFor(
  kind: ClientKind,
  setup: OutsideSetupWire,
  token: string | null,
): string {
  const t = token ?? TOKEN_PLACEHOLDER;
  const name = setup.serverName;
  if (kind === "claude-desktop" || kind === "cursor") {
    return JSON.stringify(
      {
        mcpServers: {
          [name]: { command: setup.command, args: [...setup.args], env: { KORA_TEAM_TOKEN: t } },
        },
      },
      null,
      2,
    );
  }
  if (kind === "claude-code") {
    return `claude mcp add ${shell(name)} --env KORA_TEAM_TOKEN=${shell(t)} -- ${[setup.command, ...setup.args].map(shell).join(" ")}`;
  }
  // Codex starts MCP servers with a scrubbed environment, so the token rides on argv.
  return [
    `[mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : q(name)}]`,
    `command = ${q(setup.command)}`,
    `args = [${[...setup.args, "--token", t].map(q).join(", ")}]`,
  ].join("\n");
}

export function lastUsedLabel(ms: number | null, now: number): string {
  if (ms === null) return "Never used";
  const d = Math.max(0, now - ms);
  if (d < 90_000) return "Used just now";
  if (d < 3_600_000) return `Used ${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `Used ${Math.round(d / 3_600_000)} h ago`;
  return `Used ${Math.round(d / 86_400_000)} d ago`;
}

export function createdLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const TOOL_WORDS: Record<string, string> = {
  list_blobs: "Listed the team",
  get_blob: "Looked at a blob",
  list_threads: "Listed threads",
  read_thread: "Read a thread",
  search: "Searched",
  send_message: "Sent a message",
  ask_kora: "Asked Kora",
  wait_for: "Waited for a reply",
  set_model: "Changed a model",
  interrupt: "Stopped a turn",
  list_outputs: "Listed outputs",
  list_groups: "Listed groups",
  send_to_group: "Posted in a group",
  hello: "Connected",
};
export const toolWords = (tool: string): string => TOOL_WORDS[tool] ?? tool;

export function auditTime(ms: number, now: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  if (new Date(now).toDateString() === d.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** What went wrong, in words, for a refused row. */
export function auditOutcome(r: OutsideAuditWire): string {
  if (r.ok) return "Done";
  const n = r.note ?? "";
  if (/rate limited/.test(n)) return "Rate limited";
  if (/revoked/.test(n)) return "Token revoked";
  if (/unknown token/.test(n)) return "Unknown token";
  if (/unknown tool/.test(n)) return "Not allowed";
  if (/bad arguments/.test(n)) return "Bad request";
  return "Refused";
}
