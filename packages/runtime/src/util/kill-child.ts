// Stopping a child process on every OS. On macOS/Linux this is exactly `child.kill(sig)`. On Windows a signal ends
// only that one process (TerminateProcess): an engine CLI started through `cmd.exe /c` (winCommand's batch path) or a
// `bash -c` command line (shellCommand) kept running behind its dead wrapper. There the exact pid's tree is ended
// instead (`taskkill /T /F`), never anything found by name.
import { killTreeWindows } from './win-exec';

interface Killable { pid?: number; exitCode?: number | null; signalCode?: NodeJS.Signals | null; kill(sig?: NodeJS.Signals): boolean }

/** `child.kill(sig)`, or on Windows the end of `child`'s whole process tree. Throws only what `kill` throws. */
export function killChild(child: Killable, sig: NodeJS.Signals = 'SIGTERM', platform: NodeJS.Platform = process.platform, killTree: (pid: number) => void = killTreeWindows): void {
  if (platform === 'win32' && child.pid) {
    if (child.exitCode == null && child.signalCode == null) killTree(child.pid);
    return;
  }
  child.kill(sig);
}

/** `process.kill(pid, sig)`, or on Windows the end of that pid's tree. */
export function killPid(pid: number, sig: NodeJS.Signals = 'SIGTERM', platform: NodeJS.Platform = process.platform, killTree: (pid: number) => void = killTreeWindows): void {
  if (platform === 'win32') { killTree(pid); return; }
  process.kill(pid, sig);
}
