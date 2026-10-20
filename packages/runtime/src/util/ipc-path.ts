import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Kora names every local endpoint by a socket FILE path (`~/.kora/kora.sock`, KORA_SOCKET_PATH, pane sockets): env
// vars, hooks and tests all pass those paths around. Windows has no unix sockets in the filesystem, so the path is
// translated to a named pipe only where it meets `net` (listen / connect / reachability). The pipe name is a hash of
// the absolute path, so every process that agrees on the path agrees on the pipe, and two homes never share one.
// A pipe is not a file: there is nothing to unlink or chmod, and it disappears with the server that holds it.

export const isWindows = process.platform === 'win32';

/** The address `net.listen` / `net.createConnection` take for the endpoint named by `socketPath`. */
export function ipcAddress(socketPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || socketPath.startsWith('\\\\.\\pipe\\') || socketPath.startsWith('\\\\?\\pipe\\')) return socketPath;
  const abs = path.win32.resolve(socketPath).toLowerCase();   // NTFS paths are case-insensitive
  const h = createHash('sha256').update(abs).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\kora-${path.win32.basename(abs).replace(/[^a-z0-9._-]/g, '_')}-${h}`;
}

/** Whether a server is listening on the endpoint (a cheap filesystem check; no connect). */
export function ipcExists(socketPath: string): boolean {
  if (isWindows) { try { return fs.existsSync(ipcAddress(socketPath)); } catch { return false; } }
  try { return fs.statSync(socketPath).isSocket(); } catch { return false; }
}
