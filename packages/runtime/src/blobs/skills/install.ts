// Installs the skills a blob session sees (docs/bots/ARCH.md D10 + the 2026-10-08 ruling "make the most of native
// capabilities"). Blob Claude sessions load no setting sources, so skills arrive as a LOCAL PLUGIN:
//
//   <blobHome>/plugin/.claude-plugin/plugin.json
//   <blobHome>/plugin/skills/<name>/SKILL.md      Kora's document pack + the blob's own skills + the user's own skills
//
// A plugin can carry hooks and MCP servers; this one carries skills only (the user's skill FOLDERS are copied, never
// their settings, hooks or MCP), which is how the user's installed skills work in a blob without loading their hooks.
// The same folders are what Codex / OpenCode blobs are pointed at from the system prompt (their Read tool opens them).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOC_SKILLS, renderSkill } from './docs-pack';

export const PLUGIN_NAME = 'kora-blob';
/** User skills that belong to Kora's own orchestration, never to a blob. */
const KORA_OWN = /^(kora|orchestrator|claude-handoff)/i;
const MAX_SKILL_BYTES = 8 * 1024 * 1024;

export interface InstalledSkill { name: string; description: string; dir: string; source: 'kora' | 'blob' | 'user' }

export interface InstallOptions {
  blobHome: string;
  /** The command that runs this install's CLI, substituted for {{KORA}}. */
  koraCmd: string;
  /** Where the user's own skills live (default: ~/.claude/skills and ~/.codex/skills). */
  userSkillDirs?: string[];
  /** Include the user's skills (default true). */
  includeUserSkills?: boolean;
}

export function pluginDir(blobHome: string): string { return path.join(blobHome, 'plugin'); }

function frontmatter(md: string): { name: string | null; description: string } {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  const get = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(m?.[1] ?? '')?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
  return { name: get('name'), description: get('description') ?? '' };
}

function dirSize(dir: string, limit: number): number {
  let total = 0;
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (total > limit) return; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else try { total += fs.statSync(p).size; } catch { /* gone */ } } };
  try { walk(dir); } catch { /* unreadable */ }
  return total;
}

function writeIfChanged(file: string, text: string): void {
  try { if (fs.readFileSync(file, 'utf8') === text) return; } catch { /* new */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function listSkillDirs(root: string): string[] {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.') && fs.existsSync(path.join(root, d.name, 'SKILL.md'))).map((d) => path.join(root, d.name)); }
  catch { return []; }
}

/** (Re)build the plugin folder. Idempotent and cheap; returns what is installed. Never throws. */
export function installBlobSkills(opts: InstallOptions): { dir: string; skills: InstalledSkill[] } {
  const root = pluginDir(opts.blobHome);
  const skillsRoot = path.join(root, 'skills');
  const skills: InstalledSkill[] = [];
  try {
    fs.mkdirSync(skillsRoot, { recursive: true });
    writeIfChanged(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN_NAME, version: '1.0.0', description: 'Skills for a Kora blob (document tools, its own skills, your installed skills).' }, null, 2) + '\n');
    const want = new Map<string, InstalledSkill>();

    for (const s of DOC_SKILLS) {
      writeIfChanged(path.join(skillsRoot, s.name, 'SKILL.md'), renderSkill(s, opts.koraCmd));
      want.set(s.name, { name: s.name, description: s.description, dir: path.join(skillsRoot, s.name), source: 'kora' });
    }
    // sources in increasing priority: user's, then the blob's own (a blob's skill of the same name wins)
    const sources: Array<{ dir: string; source: 'user' | 'blob' }> = [];
    if (opts.includeUserSkills !== false) {
      const roots = opts.userSkillDirs ?? [path.join(os.homedir(), '.claude', 'skills'), path.join(os.homedir(), '.codex', 'skills')];
      for (const r of roots) for (const d of listSkillDirs(r)) sources.push({ dir: d, source: 'user' });
    }
    for (const d of listSkillDirs(path.join(opts.blobHome, 'skills'))) sources.push({ dir: d, source: 'blob' });
    for (const s of sources) {
      const base = path.basename(s.dir);
      if (s.source === 'user' && (KORA_OWN.test(base) || DOC_SKILLS.some((k) => k.name === base))) continue;
      let md = ''; try { md = fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'); } catch { continue; }
      const fm = frontmatter(md);
      const name = (fm.name ?? base).replace(/[^\w.-]/g, '-');
      if (want.get(name)?.source === 'kora') continue; // Kora's own names are reserved
      if (dirSize(s.dir, MAX_SKILL_BYTES) > MAX_SKILL_BYTES) continue;
      want.set(name, { name, description: fm.description, dir: path.join(skillsRoot, name), source: s.source });
      const dest = path.join(skillsRoot, name);
      const sig = (d: string) => { try { return fs.readdirSync(d).length + ':' + fs.statSync(path.join(d, 'SKILL.md')).mtimeMs; } catch { return ''; } };
      let sameAs = false;
      try { sameAs = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8') === md && sig(dest).split(':')[0] === sig(s.dir).split(':')[0]; } catch { /* absent */ }
      if (!sameAs) { fs.rmSync(dest, { recursive: true, force: true }); fs.cpSync(s.dir, dest, { recursive: true, dereference: true }); }
    }
    // drop skills that no longer exist at any source
    for (const e of fs.readdirSync(skillsRoot, { withFileTypes: true })) if (e.isDirectory() && !want.has(e.name)) fs.rmSync(path.join(skillsRoot, e.name), { recursive: true, force: true });
    skills.push(...want.values());
  } catch (e: any) {
    console.error(`[kora] blob skills install failed: ${e?.message ?? e}`);
  }
  return { dir: root, skills };
}

/** The skill index a non-Claude engine reads (Claude has the native Skill tool): one line each + the file to open. */
export function skillIndexText(skills: InstalledSkill[], skillsRootDir: string): string {
  if (!skills.length) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').slice(0, 160)} (${path.join(skillsRootDir, s.name, 'SKILL.md')})`);
  return lines.join('\n');
}
