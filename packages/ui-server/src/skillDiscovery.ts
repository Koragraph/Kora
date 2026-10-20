// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off globalDate:off -- plain Node fs reads and a bounded
// `codex app-server` stdio probe at the daemon boundary, not Effect fibers (same style as codexModels.ts).
//
// Which skills each agent can run in a folder, so the composer's `$` / `/` menus have something to list.
// Skills belong to the agent CLI, not to Kora, so each agent is asked in its own way:
//   - Claude Code: read `SKILL.md` files from where Claude Code looks (user, project, installed plugins) and apply the
//     user's `skillOverrides`. Claude's SDK exposes no skill list, so the files are the source of truth.
//   - Codex: ask `codex app-server` (`skills/list`), which already applies Codex's own roots, plugins and config.
// Everything is best-effort and bounded: an unreadable folder or a missing CLI yields fewer skills, never an error.
import { spawn } from "node:child_process";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";

import type { AgentSkill } from "@kora/contracts";
import { koraHome } from "./paths.ts";
import { envPath, exeCandidates, killChild, winCommand } from "./winSpawn.ts";

type Skill = AgentSkill;

/** The handful of `SKILL.md` frontmatter keys Kora reads. Anything else in the block is ignored. */
export interface SkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly disableModelInvocation?: boolean;
  readonly userInvocable?: boolean;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0])
    return v.slice(1, -1);
  return v;
}

function bool(value: string | undefined): boolean | undefined {
  const v = value?.trim().toLowerCase();
  return v === "true" ? true : v === "false" ? false : undefined;
}

/** Minimal frontmatter reader: `key: value`, quoted values, and `>` / `|` block scalars (folded to one line). */
export function parseSkillFrontmatter(markdown: string): SkillFrontmatter | null {
  const match = FRONTMATTER.exec(markdown);
  if (!match) return null;
  const raw = new Map<string, string>();
  const lines = (match[1] ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[i] ?? "");
    if (!m) continue;
    let value = m[2] ?? "";
    if (/^[>|][+-]?$/.test(value.trim())) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1] ?? "")) {
        parts.push((lines[++i] ?? "").trim());
      }
      value = parts.filter(Boolean).join(" ");
    }
    raw.set(m[1]!, unquote(value));
  }
  const name = raw.get("name");
  const description = raw.get("description");
  const disableModelInvocation = bool(raw.get("disable-model-invocation"));
  const userInvocable = bool(raw.get("user-invocable"));
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    ...(userInvocable !== undefined ? { userInvocable } : {}),
  };
}

function readText(file: string): string | null {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson(file: string): unknown {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `<root>/<dir>/SKILL.md` for every immediate child folder of `root` (symlinked skill folders included). */
function skillFilesUnder(root: string): string[] {
  let entries: NodeFS.Dirent[];
  try {
    entries = NodeFS.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const file = NodePath.join(root, entry.name, "SKILL.md");
    if (NodeFS.existsSync(file)) out.push(file);
  }
  return out.sort();
}

function toSkill(file: string, scope: string, namePrefix = ""): Skill | null {
  const text = readText(file);
  if (text === null) return null;
  const fm = parseSkillFrontmatter(text);
  // A skill's name is its frontmatter `name`, else its folder name (Claude Code's rule).
  const base = fm?.name ?? NodePath.basename(NodePath.dirname(file));
  if (!base.trim()) return null;
  return {
    name: `${namePrefix}${base}`,
    ...(fm?.description ? { description: fm.description } : {}),
    path: file,
    scope,
    enabled: true,
    ...(fm?.disableModelInvocation === true ? { userInvocationOnly: true } : {}),
    ...(fm?.userInvocable === false ? { userInvocable: false } : {}),
  };
}

function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = NodeOS.homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? dir : NodePath.join(home, ".claude");
}

/** The git root at or above `cwd`, or null outside a repository. */
function gitRoot(cwd: string): string | null {
  let dir = NodePath.resolve(cwd);
  for (;;) {
    if (NodeFS.existsSync(NodePath.join(dir, ".git"))) return dir;
    const parent = NodePath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Folders whose `.claude/skills` apply to `cwd`: the folder itself and every parent up to the repo root. */
function projectSkillDirs(cwd: string): string[] {
  const root = gitRoot(cwd);
  const dirs: string[] = [];
  let dir = NodePath.resolve(cwd);
  for (;;) {
    dirs.push(NodePath.join(dir, ".claude", "skills"));
    if (root === null || dir === root) break;
    const parent = NodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * Skills the user switched off in Claude Code's settings, lowest precedence first (user, project, project-local).
 * `skillOverrides` maps a skill name to "off" (or `false`); anything else leaves it on. A later file wins.
 */
function claudeSkillOverrides(configDir: string, cwd: string | null): Map<string, boolean> {
  const files = [NodePath.join(configDir, "settings.json")];
  if (cwd) {
    files.push(
      NodePath.join(cwd, ".claude", "settings.json"),
      NodePath.join(cwd, ".claude", "settings.local.json"),
    );
    const root = gitRoot(cwd);
    if (root && root !== cwd) files.push(NodePath.join(root, ".claude", "settings.local.json"));
  }
  const out = new Map<string, boolean>();
  for (const file of files) {
    const json = readJson(file) as { skillOverrides?: unknown } | null;
    const overrides = json?.skillOverrides;
    if (!overrides || typeof overrides !== "object") continue;
    for (const [name, value] of Object.entries(overrides as Record<string, unknown>)) {
      const off = value === "off" || value === false;
      out.set(name, !off);
    }
  }
  return out;
}

/** Install folders of Claude Code plugins, from `plugins/installed_plugins.json` (absent until a plugin is installed). */
function installedPluginRoots(configDir: string): Array<{ plugin: string; root: string }> {
  const json = readJson(NodePath.join(configDir, "plugins", "installed_plugins.json")) as {
    plugins?: Record<string, unknown>;
  } | null;
  const out: Array<{ plugin: string; root: string }> = [];
  for (const [key, installs] of Object.entries(json?.plugins ?? {})) {
    const first = Array.isArray(installs)
      ? (installs[0] as { installPath?: unknown } | undefined)
      : undefined;
    if (typeof first?.installPath === "string")
      out.push({ plugin: key.split("@")[0] ?? key, root: first.installPath });
  }
  return out;
}

/** Skills Claude Code would list for `cwd` (or only the user-level ones when `cwd` is null). */
export function discoverClaudeSkills(
  cwd: string | null,
  env: NodeJS.ProcessEnv = process.env,
  home = NodeOS.homedir(),
): Skill[] {
  const configDir = claudeConfigDir(env, home);
  const found: Skill[] = [];
  // Project beats user beats plugin on a name clash (Claude Code's own precedence), so they are added in that order.
  if (cwd) {
    for (const dir of projectSkillDirs(cwd)) {
      for (const file of skillFilesUnder(dir)) {
        const skill = toSkill(file, "project");
        if (skill) found.push(skill);
      }
    }
  }
  for (const file of skillFilesUnder(NodePath.join(configDir, "skills"))) {
    const skill = toSkill(file, "user");
    if (skill) found.push(skill);
  }
  for (const { plugin, root } of installedPluginRoots(configDir)) {
    for (const file of skillFilesUnder(NodePath.join(root, "skills"))) {
      const skill = toSkill(file, "plugin", `${plugin}:`);
      if (skill) found.push(skill);
    }
  }
  const overrides = claudeSkillOverrides(configDir, cwd);
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const skill of found) {
    const key = skill.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(overrides.get(skill.name) === false ? { ...skill, enabled: false } : skill);
  }
  return out;
}

// ── Codex ────────────────────────────────────────────────────────────────────────────────────────────

interface CodexSkillRow {
  name?: unknown;
  description?: unknown;
  shortDescription?: unknown;
  path?: unknown;
  scope?: unknown;
  enabled?: unknown;
  interface?: { displayName?: unknown; shortDescription?: unknown } | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Map one `skills/list` row; a row without a name or path is dropped. */
export function mapCodexSkill(row: CodexSkillRow): Skill | null {
  const name = str(row.name);
  const path = str(row.path);
  if (!name || !path) return null;
  const description = str(row.description);
  const displayName = str(row.interface?.displayName);
  const shortDescription = str(row.interface?.shortDescription) ?? str(row.shortDescription);
  const scope = str(row.scope);
  return {
    name,
    ...(description ? { description } : {}),
    path,
    ...(scope ? { scope } : {}),
    enabled: row.enabled !== false,
    ...(displayName ? { displayName } : {}),
    ...(shortDescription ? { shortDescription } : {}),
  };
}

const CODEX_PROBE_TIMEOUT_MS = 6000;

/** The absolute, executable codex path from `<koraHome>/engines.json` `executables.codex`, or null. */
export function explicitCodexPath(koraHomeDir: string): string | null {
  try {
    const j = JSON.parse(
      NodeFS.readFileSync(NodePath.join(koraHomeDir, "engines.json"), "utf8"),
    ) as {
      executables?: { codex?: unknown };
    };
    const p = j.executables?.codex;
    if (typeof p !== "string" || !NodePath.isAbsolute(p)) return null;
    NodeFS.accessSync(p, NodeFS.constants.X_OK);
    return p;
  } catch {
    return null;
  }
}

/**
 * The `codex` executable. A daemon started from a shell script or launchd has a bare PATH (/usr/bin:/bin), so the
 * usual install spots are tried too; falls back to plain "codex" so a PATH that does have it still works.
 */
export function resolveCodexBin(
  home = NodeOS.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  koraHomeDir: string | null = koraHome(),
): string {
  // The path set in Settings > Engines (<KORA_HOME>/engines.json executables.codex) wins, as it does for the chat lane (deep A3-10).
  const explicit = koraHomeDir ? explicitCodexPath(koraHomeDir) : null;
  if (explicit) return explicit;
  const dirs = [
    ...(envPath(env) ?? "").split(NodePath.delimiter),
    NodePath.join(home, ".local", "bin"),
    NodePath.join(home, ".codex", "packages", "standalone", "current", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const file of exeCandidates(NodePath.join(dir, "codex"))) {
      try {
        NodeFS.accessSync(file, NodeFS.constants.X_OK); // Windows: exists (PATHEXT names only, from exeCandidates)
        if (process.platform === "win32" && exeCandidates(file).length !== 1) continue;
        return file;
      } catch {
        /* next */
      }
    }
  }
  return "codex";
}

/** `codex app-server` → `skills/list` for `cwds`. Resolves a cwd→skills map, or null on any failure. */
export function probeCodexSkills(
  cwds: ReadonlyArray<string>,
  timeoutMs = CODEX_PROBE_TIMEOUT_MS,
): Promise<Map<string, Skill[]> | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const w = winCommand(resolveCodexBin(), ["app-server"]);
      child = spawn(w.command, w.args, {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        windowsVerbatimArguments: w.windowsVerbatimArguments,
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let buf = "";
    const finish = (result: Map<string, Skill[]> | null) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      try {
        killChild(child, "SIGKILL");
      } catch {
        /* best effort */
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    const send = (o: unknown) => {
      try {
        child.stdin?.write(`${JSON.stringify(o)}\n`);
      } catch {
        finish(null);
      }
    };
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg: { id?: unknown; result?: { data?: unknown } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "skills/list",
            params: { cwds: [...cwds], forceReload: true },
          });
        } else if (msg.id === 2) {
          const data = msg.result?.data;
          if (!Array.isArray(data)) return finish(null);
          const out = new Map<string, Skill[]>();
          for (const entry of data as Array<{ cwd?: unknown; skills?: unknown }>) {
            const cwd = str(entry.cwd);
            if (!cwd || !Array.isArray(entry.skills)) continue;
            const skills = (entry.skills as CodexSkillRow[])
              .map(mapCodexSkill)
              .filter((s): s is Skill => s !== null);
            out.set(cwd, skills);
          }
          return finish(out);
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "kora", title: null, version: "0.0.0" }, capabilities: null },
    });
  });
}
