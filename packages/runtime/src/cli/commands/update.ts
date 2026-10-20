// `kora update`: re-run install.sh from the source recorded by the last install (git URL or a checkout path).
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { IO } from '../main';
import { koraHome } from '../../protocol/types';
import { appDir, versionString } from './version';

export const summary = 'How to update Kora (the app updates itself); a checkout install re-runs install.sh';
export const usage = `kora update [--source <git-url|path>]

Reads ~/.kora/install-source.json (written by install.sh) and re-runs install.sh from that source:
a git URL is pulled --ff-only; a local checkout is rsynced. Then npm ci, build, and the ~/.local/bin/kora link is refreshed.
Restart the server afterwards to run the new code: kora server stop && kora

Windows: prints how to update (the latest Kora-Setup-*.exe from the releases page, or the app's own updater).`;

/** The public releases page: installers for every OS (the source repo is private). */
export const RELEASES_URL = 'https://github.com/agilkatakam/kora/releases/latest';

/**
 * Windows: Kora is installed by Kora-Setup-<version>.exe (per-user NSIS, no admin) and there is no install.sh or bash to
 * re-run. The app updates itself once the Windows update feed ships; until then a newer installer replaces it in place.
 */
export function windowsUpdateMessage(version: string): string {
  return `${version} on Windows is installed by Kora-Setup-<version>.exe; there is no install script to re-run.
To update: quit Kora, download the latest Kora-Setup-*.exe from ${RELEASES_URL} and run it. It replaces the app in
place (per-user, no admin) and keeps your settings, chats and %USERPROFILE%\\.kora. Releases with the Windows update feed
update themselves in the background (Settings → About shows the state).
`;
}

export async function run(argv: string[], io: IO, platform: NodeJS.Platform = process.platform): Promise<number> {
  if (platform === 'win32') { io.out(windowsUpdateMessage(versionString())); return 0; }
  const i = argv.indexOf('--source'); let source = i >= 0 ? argv[i + 1] : undefined;
  const recFile = path.join(koraHome(), 'install-source.json');
  let rec: { source?: string; build?: string } | null = null;
  try { rec = JSON.parse(fs.readFileSync(recFile, 'utf8')); } catch { /* none */ }
  // Kora.app keeps ~/.kora/app itself (kora-runtime.sh writes `build`): there is no install.sh to re-run.
  if (i < 0 && rec?.build) {
    io.out(`${versionString()} (build ${rec.build}) is managed by Kora.app, which updates itself: it checks the published releases, downloads a new version in the background and offers to restart into it (Settings → About shows the state).
Nothing to run here. A build without an update feed (a local dev build) is replaced from its checkout instead: pnpm app:install.
`);
    return 0;
  }
  if (!source) source = rec?.source;
  const script = [path.join(appDir(), 'install.sh'), source ? path.join(source, 'install.sh') : ''].find((f) => f && fs.existsSync(f));
  if (!script) { io.err(`kora update: no install.sh found (looked in ${appDir()}${source ? ` and ${source}` : ''}). Run install.sh from a checkout once.\n`); return 1; }
  if (!source) { io.err(`kora update: no recorded source in ${recFile}; pass --source <git-url|path>\n`); return 1; }
  io.out(`${versionString()} → updating from ${source}\n`);
  const code = await new Promise<number>((resolve) => { const c = spawn('bash', [script, source!], { stdio: 'inherit', env: { ...process.env, KORA_UPDATE: '1' } }); c.on('exit', (n) => resolve(n ?? 1)); c.on('error', () => resolve(1)); });
  if (code === 0) io.out('updated. Restart the server to run it: kora server stop && kora\n');
  return code;
}
