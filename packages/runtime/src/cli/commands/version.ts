// `kora version` / `kora --version`: package version + git commit of the installed checkout, best effort.
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { IO } from '../main';
import { version } from '../../../package.json';

export const summary = 'Print the version and the commit it was built from';
export const usage = 'kora version';

export function appDir(): string { return path.resolve(__dirname, '..', '..', '..'); }
export function commitOf(dir: string): string | null {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim() || null; } catch { /* not a checkout */ }
  try { const rec = JSON.parse(fs.readFileSync(path.join(dir, '..', 'install-source.json'), 'utf8')); return rec.commit || null; } catch { return null; }
}
export function versionString(): string { const c = commitOf(appDir()); return `kora ${version}${c ? ` (${c})` : ''}`; }
export async function run(_argv: string[], io: IO): Promise<number> { io.out(`${versionString()}\n${appDir()}\n`); return 0; }
