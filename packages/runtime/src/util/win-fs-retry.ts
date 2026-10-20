// Windows only: a rename onto a file another process has open this instant fails with EPERM / EACCES / EBUSY (a
// reader of settings.json, an antivirus scan of a fresh file). Kora replaces files by tmp + rename in dozens of places
// (atomic writes of state, stores, settings), so rather than wrap each one, rename is retried briefly for the whole
// process — what graceful-fs does. Installed once by the CLI entry (cli/main.ts), which also hosts the daemon and the
// ui-server bundle. A no-op on macOS/Linux.
import fs from 'node:fs';

const RETRY = /^(EPERM|EACCES|EBUSY)$/;
const WINDOW_MS = 2000;
let installed = false;

export function installWindowsRenameRetry(): void {
  if (installed || process.platform !== 'win32') return;
  installed = true;
  const renameSync = fs.renameSync.bind(fs);
  fs.renameSync = (from: fs.PathLike, to: fs.PathLike): void => {
    const deadline = Date.now() + WINDOW_MS;
    for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
      try { return renameSync(from, to); }
      catch (e: any) {
        if (!RETRY.test(String(e?.code)) || Date.now() > deadline) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      }
    }
  };
  const rename = fs.promises.rename.bind(fs.promises);
  fs.promises.rename = async (from: fs.PathLike, to: fs.PathLike): Promise<void> => {
    const deadline = Date.now() + WINDOW_MS;
    for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
      try { return await rename(from, to); }
      catch (e: any) {
        if (!RETRY.test(String(e?.code)) || Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };
}
