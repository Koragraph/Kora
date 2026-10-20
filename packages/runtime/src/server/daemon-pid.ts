// <KORA_HOME>/daemon.pid: the one daemon's pid, so a supervisor that finds the daemon up but not answering (desktop app,
// kora-runtime.sh ensure) can stop EXACTLY that process — never by pattern. Written when the daemon starts, removed on a
// clean shutdown; a stale file is harmless (the supervisor checks the pid is alive and still a `server run` process).
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';

export const daemonPidPath = (): string => path.join(koraHome(), 'daemon.pid');

export function writeDaemonPid(): void {
  try { fs.mkdirSync(koraHome(), { recursive: true, mode: 0o700 }); fs.writeFileSync(daemonPidPath(), `${process.pid}\n`, { mode: 0o600 }); } catch { /* best effort */ }
}
export function removeDaemonPid(): void {
  try { if (fs.readFileSync(daemonPidPath(), 'utf8').trim() === String(process.pid)) fs.unlinkSync(daemonPidPath()); } catch { /* gone */ }
}
