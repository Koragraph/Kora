// Skills (a folder with SKILL.md: YAML front matter `name` + `description`, then instructions). Kora keeps its copy in
// <KORA_HOME>/extensions/skills/<name> and links it into each agent's own skills folder, so every agent finds it the
// way it finds the user's other skills. Kora only ever removes links that point at its own copy.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { koraHome } from '../protocol/types';
import { agentsHome, EXTENSION_AGENTS, type ExtensionAgent, type Skill } from './model';
import { extensionsDir, loadExtensions, removeSkillEntry, upsertSkill } from './store';

const run = promisify(execFile);
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Where each agent looks for user skills (the folders that exist get a link). */
export function agentSkillDirs(home = agentsHome()): Record<ExtensionAgent, string[]> {
  const codexHome = process.env.CODEX_HOME ?? path.join(home, '.codex');
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return {
    claude: [path.join(home, '.claude', 'skills')],
    codex: [path.join(codexHome, 'skills')],
    opencode: [path.join(xdg, 'opencode', 'skill')],
    antigravity: [path.join(home, '.gemini', 'antigravity', 'skills'), path.join(home, '.gemini', 'antigravity-cli', 'skills')],
  };
}

/** The app folder an agent's skills folder lives in must exist (the agent is installed); the skills folder may not. */
const agentInstalled = (skillsDir: string) => fs.existsSync(path.dirname(skillsDir));

export function readSkillMeta(dir: string): { name: string; description: string } | null {
  let text: string;
  try { text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch { return null; }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  const name = field('name') || path.basename(dir);
  return { name: name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''), description: field('description') };
}

/** Every skill folder under `root`: root itself, its children, or `skills/*` (how skill repos are usually laid out). */
export function findSkillDirs(root: string): string[] {
  if (fs.existsSync(path.join(root, 'SKILL.md'))) return [root];
  const out: string[] = [];
  for (const base of [root, path.join(root, 'skills')]) {
    let names: string[] = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const n of names) if (fs.existsSync(path.join(base, n, 'SKILL.md'))) out.push(path.join(base, n));
  }
  return out;
}

function linkInto(skill: Skill, home: string): string[] {
  const linked: string[] = [];
  const dirs = agentSkillDirs(home);
  for (const agent of skill.agents) {
    for (const d of dirs[agent]) {
      if (!agentInstalled(d)) continue;
      const target = path.join(d, skill.name);
      try {
        const st = fs.lstatSync(target);
        if (!st.isSymbolicLink() || fs.readlinkSync(target) !== skill.dir) continue; // the user's own skill of that name wins
        linked.push(target);
        continue;
      } catch { /* absent: link it */ }
      fs.mkdirSync(d, { recursive: true });
      fs.symlinkSync(skill.dir, target, 'dir');
      linked.push(target);
    }
  }
  return linked;
}

function unlinkFrom(skill: Skill, home: string): void {
  for (const list of Object.values(agentSkillDirs(home))) {
    for (const d of list) {
      const target = path.join(d, skill.name);
      try { if (fs.lstatSync(target).isSymbolicLink() && fs.readlinkSync(target) === skill.dir) fs.unlinkSync(target); } catch { /* not ours / absent */ }
    }
  }
}

export interface SkillInstallResult { installed: Skill[]; skipped: { name: string; reason: string }[] }

/**
 * Install from a folder or a git URL (https or git@). A repository with several skills installs each. An existing
 * Kora-managed skill of the same name is replaced; a user's own (non-Kora) skill of that name is never touched.
 */
export async function installSkills(source: string, opts: { agents?: ExtensionAgent[]; home?: string; koraHomeDir?: string } = {}): Promise<SkillInstallResult> {
  const kh = opts.koraHomeDir ?? koraHome();
  const home = opts.home ?? agentsHome();
  const agents = opts.agents?.length ? opts.agents : [...EXTENSION_AGENTS];
  let root = source.trim().replace(/^~(?=\/)/, home);
  let tmp: string | null = null;
  if (/^(https:\/\/|git@)/.test(root)) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-skill-'));
    await run('git', ['clone', '--depth', '1', '--quiet', '--', root, tmp], { timeout: 120_000 });
    root = tmp;
  }
  try {
    if (!fs.existsSync(root)) throw new Error(`${source} does not exist.`);
    const found = findSkillDirs(root);
    if (found.length === 0) throw new Error('No SKILL.md found (looked in the folder, its subfolders and skills/*).');
    const result: SkillInstallResult = { installed: [], skipped: [] };
    for (const dir of found) {
      const meta = readSkillMeta(dir);
      if (!meta || !SKILL_NAME.test(meta.name)) { result.skipped.push({ name: path.basename(dir), reason: 'its SKILL.md has no usable name' }); continue; }
      const dest = path.join(extensionsDir(kh), 'skills', meta.name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(dir, dest, { recursive: true, filter: (p) => path.basename(p) !== '.git' });
      const skill: Skill = { name: meta.name, description: meta.description, dir: dest, agents, enabled: true, source: tmp ? source : `folder:${path.resolve(dir)}` };
      linkInto(skill, home);
      upsertSkill(skill, kh);
      result.installed.push(skill);
    }
    return result;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function setSkillEnabled(name: string, enabled: boolean, opts: { home?: string; koraHomeDir?: string } = {}): Skill {
  const kh = opts.koraHomeDir ?? koraHome();
  const skill = loadExtensions(kh).skills.find((k) => k.name === name);
  if (!skill) throw new Error(`No skill named "${name}".`);
  const next = { ...skill, enabled };
  if (enabled) linkInto(next, opts.home ?? agentsHome()); else unlinkFrom(next, opts.home ?? agentsHome());
  upsertSkill(next, kh);
  return next;
}

export function removeSkill(name: string, opts: { home?: string; koraHomeDir?: string } = {}): boolean {
  const kh = opts.koraHomeDir ?? koraHome();
  const skill = removeSkillEntry(name, kh);
  if (!skill) return false;
  unlinkFrom(skill, opts.home ?? agentsHome());
  if (skill.dir.startsWith(extensionsDir(kh))) fs.rmSync(skill.dir, { recursive: true, force: true });
  return true;
}

/** Per agent: which skills are linked where (for the settings page). */
export function skillLinks(skill: Skill, home = agentsHome()): Partial<Record<ExtensionAgent, boolean>> {
  const out: Partial<Record<ExtensionAgent, boolean>> = {};
  const dirs = agentSkillDirs(home);
  for (const agent of EXTENSION_AGENTS) {
    out[agent] = dirs[agent].some((d) => {
      try { return fs.readlinkSync(path.join(d, skill.name)) === skill.dir; } catch { return false; }
    });
  }
  return out;
}
