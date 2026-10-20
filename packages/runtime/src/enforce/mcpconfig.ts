// MCP config injection — so the graph also exists as mcp__kora__* tools in every agent that
// speaks MCP. Belt and braces next to the CLI/hook channel. JSON files are merged key-by-key;
// codex's TOML is appended as a section (never re-serialised, so comments and layout survive).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { KORA_BIN, NODE_BIN, koraHome } from '../graph/embedded';
import type { AdapterResult } from './index';
import { unsafeRepoWrite } from '../util/safe-path';
import { writeFileAtomic } from '../util/atomic-write';

export const SERVER_NAME = 'kora';

export function mcpServerSpec(): { command: string; args: string[] } {
  return { command: NODE_BIN, args: [KORA_BIN, 'mcp'] };
}

export function claudeMcpJsonPath(): string { return path.join(koraHome(), 'mcp', 'claude.json'); }

function readJson(file: string): any {
  try { const raw = fs.readFileSync(file, 'utf8').trim(); return raw ? JSON.parse(raw) : {}; } catch (e: any) {
    if (e && e.code === 'ENOENT') return {};
    throw new Error(`${file} is not valid JSON (${e.message}) — fix or remove it, then re-run`);
  }
}
function writeJson(file: string, obj: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
}
function getPath(obj: any, keys: string[]): any {
  let cur = obj;
  for (const k of keys) { if (!cur || typeof cur !== 'object') return undefined; cur = cur[k]; }
  return cur;
}
function setPath(obj: any, keys: string[], value: any): void {
  let cur = obj;
  for (const k of keys.slice(0, -1)) { if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}; cur = cur[k]; }
  cur[keys[keys.length - 1]] = value;
}

/** `root`: the repository the file belongs to, when it is a repo file (.mcp.json, .gemini/settings.json …) — a
 *  symlinked file or directory there never redirects the write outside it. */
export function upsertJsonKey(file: string, keys: string[], value: any, agent: string, root?: string): AdapterResult {
  const unsafe = unsafeRepoWrite(file, root);
  if (unsafe) return { agent, action: 'skipped', file, detail: unsafe };
  let obj: any;
  try { obj = readJson(file); } catch (e: any) { return { agent, action: 'skipped', file, detail: e.message }; }
  const existed = fs.existsSync(file);
  const before = JSON.stringify(getPath(obj, keys));
  if (before === JSON.stringify(value)) return { agent, action: 'managed', file, detail: `${keys.join('.')} present` };
  setPath(obj, keys, value);
  writeJson(file, obj);
  return { agent, action: before === undefined && existed ? 'installed' : existed ? 'refreshed' : 'installed', file, detail: `${keys.join('.')} written` };
}

export function removeJsonKey(file: string, keys: string[], agent: string, root?: string): AdapterResult {
  const unsafe = unsafeRepoWrite(file, root);
  if (unsafe) return { agent, action: 'skipped', file, detail: unsafe };
  if (!fs.existsSync(file)) return { agent, action: 'absent', file };
  let obj: any;
  try { obj = readJson(file); } catch (e: any) { return { agent, action: 'skipped', file, detail: e.message }; }
  const parent = getPath(obj, keys.slice(0, -1));
  const last = keys[keys.length - 1];
  if (!parent || !(last in parent)) return { agent, action: 'absent', file, detail: `${keys.join('.')} not present` };
  delete parent[last];
  writeJson(file, obj);
  return { agent, action: 'removed', file, detail: `${keys.join('.')} removed` };
}

export function jsonKeyStatus(file: string, keys: string[], agent: string): AdapterResult {
  try { return getPath(readJson(file), keys) ? { agent, action: 'managed', file } : { agent, action: 'absent', file }; }
  catch { return { agent, action: 'absent', file, detail: 'unreadable' }; }
}

/** ~/.kora/mcp/claude.json — passed to `claude --mcp-config`. */
export function writeClaudeMcpJson(): AdapterResult {
  return upsertJsonKey(claudeMcpJsonPath(), ['mcpServers', SERVER_NAME], { type: 'stdio', ...mcpServerSpec() }, 'claude');
}

// ---- codex: ~/.codex/config.toml ----
export function codexConfigPath(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
}
// The section header through every following line that is not itself a section header.
const CODEX_SECTION_RE = /\n?\[mcp_servers\.kora\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/;

function tomlString(s: string): string { return JSON.stringify(s); }

export function codexSection(): string {
  const spec = mcpServerSpec();
  return `\n[mcp_servers.kora]\ncommand = ${tomlString(spec.command)}\nargs = [${spec.args.map(tomlString).join(', ')}]\n`;
}

/**
 * A second install (Kora Dev's ~/.kora-dev, a QA stack) must not write the MACHINE-WIDE ~/.codex/config.toml: the entry is
 * shared with the stable Kora, last installer wins, and stable users' Codex would start running the dev runtime. Such a
 * flavor gets its MCP through the per-session `-c mcp_servers.kora.*` overrides (codexOverrides) only.
 */
export function isFlavoredHome(): boolean {
  const def = path.join(os.homedir(), '.kora');
  try { return path.resolve(koraHome()) !== path.resolve(def); } catch { return false; }
}
/** Does this [mcp_servers.kora] section belong to THIS install (its runtime dir or bin)? */
function ownsCodexSection(section: string): boolean {
  return section.includes(KORA_BIN) || section.includes(path.join(koraHome(), 'app'));
}

export function upsertCodexMcp(file?: string): AdapterResult {
  if (file === undefined) {
    if (isFlavoredHome()) return { agent: 'codex', action: 'skipped', file: codexConfigPath(), detail: `${koraHome()} is a separate install: the shared ~/.codex/config.toml stays with the stable Kora (sessions get -c overrides)` };
    file = codexConfigPath();
  }
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { existing = ''; }
  let parsed: any = null;
  if (existing.trim()) {
    try { parsed = require('smol-toml').parse(existing); } catch (e: any) {
      return { agent: 'codex', action: 'skipped', file, detail: `config.toml does not parse (${e.message}); pass -c overrides only` };
    }
  }
  const present = parsed && parsed.mcp_servers && parsed.mcp_servers.kora;
  const section = codexSection();
  if (present) {
    const spec = mcpServerSpec();
    const same = present.command === spec.command && JSON.stringify(present.args) === JSON.stringify(spec.args);
    if (same) return { agent: 'codex', action: 'managed', file, detail: 'mcp_servers.kora present' };
    // Ours but stale (bin moved): replace the section text in place.
    if (CODEX_SECTION_RE.test(existing)) {
      writeFileAtomic(file, existing.replace(CODEX_SECTION_RE, section));
      return { agent: 'codex', action: 'refreshed', file, detail: 'mcp_servers.kora updated' };
    }
    return { agent: 'codex', action: 'skipped', file, detail: 'mcp_servers.kora exists with a different command (inline table?) — left as is' };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${existing.replace(/\s*$/, '')}\n${section}`);
  return { agent: 'codex', action: 'installed', file, detail: 'mcp_servers.kora appended' };
}

/**
 * Mark `root` trusted in Codex's config (`[projects."<root>"] trust_level = "trusted"`), so a codex pane opened
 * there skips the per-directory trust dialog. Only called for paths under kora's trustedRoots — the same
 * gate the Claude trust auto-answer uses — and never touches an entry that is already there.
 */
export function upsertCodexTrust(root: string, file = codexConfigPath()): AdapterResult {
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { existing = ''; }
  if (existing.trim()) {
    try {
      const parsed = require('smol-toml').parse(existing);
      const cur = parsed?.projects?.[root]?.trust_level;
      if (cur !== undefined) return { agent: 'codex', action: cur === 'trusted' ? 'managed' : 'skipped', file, detail: `projects.${tomlString(root)}.trust_level = ${JSON.stringify(cur)}` };
    } catch (e: any) {
      return { agent: 'codex', action: 'skipped', file, detail: `config.toml does not parse (${e.message}); trust dialog left to auto-answer` };
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${existing.replace(/\s*$/, '')}\n\n[projects.${tomlString(root)}]\ntrust_level = "trusted"\n`);
  recordCodexTrustAdded(root);
  return { agent: 'codex', action: 'installed', file, detail: `projects.${tomlString(root)} trusted` };
}

/**
 * The trust lines Kora itself added to Codex's config (a Codex-written line looks identical, so only a ledger tells
 * them apart). `kora uninstall` removes exactly these.
 */
export function codexTrustLedgerPath(home = koraHome()): string { return path.join(home, 'kora-daemon', 'codex-trust-added.json'); }
export function readCodexTrustLedger(home = koraHome()): string[] {
  try { const v = JSON.parse(fs.readFileSync(codexTrustLedgerPath(home), 'utf8')); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function recordCodexTrustAdded(root: string): void {
  try {
    const roots = readCodexTrustLedger();
    if (roots.includes(root)) return;
    const file = codexTrustLedgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify([...roots, root], null, 2)}\n`);
  } catch { /* the ledger is best effort */ }
}

/**
 * Remove the trust entries Kora added (the ledger's roots) from a Codex config. Only a block that is still exactly
 * `[projects."<root>"]` + `trust_level = "trusted"` goes; an entry the user edited or extended stays.
 */
export function removeCodexTrustAdded(file: string, roots: readonly string[]): string[] {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const removed: string[] = [];
  for (const root of roots) {
    const header = `[projects.${tomlString(root)}]`;
    const re = new RegExp(`(?:^|\\n)${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\ntrust_level[ \\t]*=[ \\t]*"trusted"[ \\t]*(?:\\n|$)`);
    if (!re.test(text)) continue;
    text = text.replace(re, '\n');
    removed.push(root);
  }
  if (removed.length > 0) writeFileAtomic(file, `${text.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s*$/, '')}\n`);
  return removed;
}

export function removeCodexMcp(explicitFile?: string): AdapterResult {
  const file = explicitFile ?? codexConfigPath();
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { return { agent: 'codex', action: 'absent', file }; }
  const m = CODEX_SECTION_RE.exec(existing);
  if (!m) return { agent: 'codex', action: 'absent', file, detail: 'no [mcp_servers.kora] section' };
  // The machine-wide file (no explicit path): another install's entry is not ours to remove. `kora uninstall` decides for itself.
  if (explicitFile === undefined && !ownsCodexSection(m[0])) return { agent: 'codex', action: 'skipped', file, detail: '[mcp_servers.kora] belongs to another Kora install — left as is' };
  writeFileAtomic(file, existing.replace(CODEX_SECTION_RE, '\n').replace(/\n{3,}/g, '\n\n'));
  return { agent: 'codex', action: 'removed', file, detail: '[mcp_servers.kora] removed' };
}

export function codexMcpStatus(file = codexConfigPath()): AdapterResult {
  try {
    const parsed = require('smol-toml').parse(fs.readFileSync(file, 'utf8'));
    return parsed?.mcp_servers?.kora ? { agent: 'codex', action: 'managed', file } : { agent: 'codex', action: 'absent', file };
  } catch { return { agent: 'codex', action: 'absent', file }; }
}

// Which agents get MCP by default. Measured across every session of the build: 0 of 20+ graph calls came through
// MCP when hooks + rulebook + system prompt + CLI were present — the schema (1.9k tokens) was re-billed on every
// call for nothing. Claude Code has all four other channels, so MCP is opt-in there (KORA_MCP=1). Agents with no
// hook system keep it on: for them it is the discoverable channel. KORA_MCP=0 forces off everywhere.
export function mcpEnabledFor(agent: string): boolean {
  const v = process.env.KORA_MCP;
  if (v === '1' || v === 'on') return true;
  if (v === '0' || v === 'off') return false;
  return agent !== 'claude';
}
