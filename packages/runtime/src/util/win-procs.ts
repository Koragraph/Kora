// The Windows stand-in for `ps`: one PowerShell CIM query (Win32_Process) returns pid, parent pid, start time and command
// line for every process (or for a few pids), asynchronously — never a synchronous spawn on the daemon's event loop.
// PowerShell starts in ~0.3–1 s, so callers query once per tick and batch their pids, never once per pid in a loop.
// On macOS/Linux nothing here is called (children.ts / workspace.ts keep `ps` / `lsof`).
import path from 'node:path';
import { execFile } from 'node:child_process';

export interface WinProc { pid: number; ppid: number; startedAt: string; commandLine: string }

/** PowerShell for the query: tab-separated rows, UTF-8, one per process; `pids` narrows it with a WQL filter. */
export function winProcScript(pids?: readonly number[]): string {
  const ids = (pids ?? []).map((p) => Math.trunc(p)).filter((p) => p > 0);
  const filter = ids.length ? ` -Filter "${ids.map((p) => `ProcessId=${p}`).join(' OR ')}"` : '';
  return [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `Get-CimInstance Win32_Process${filter} | ForEach-Object {`,
    "  $t = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }",
    "  '{0}`t{1}`t{2}`t{3}' -f $_.ProcessId, $_.ParentProcessId, $t, ($_.CommandLine -replace '[\\r\\n\\t]', ' ')",
    '}',
  ].join('\n');
}

/** Parse the query's output. Rows without a pid are skipped; a process without a command line has ''. */
export function parseWinProcs(text: string): WinProc[] {
  const out: WinProc[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, startedAt = '', ...rest] = line.split('\t');
    const n = Number(pid);
    if (!pid || !Number.isInteger(n) || n <= 0) continue;
    out.push({ pid: n, ppid: Number(ppid) || 0, startedAt, commandLine: rest.join('\t').trim() });
  }
  return out;
}

const powershell = (env: NodeJS.ProcessEnv = process.env): string =>
  path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Every process (or just `pids`), or null when the query failed or timed out. */
export function listWindowsProcesses(pids?: readonly number[], timeoutMs = 10_000): Promise<WinProc[] | null> {
  return new Promise((resolve) => execFile(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', winProcScript(pids)],
    { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    (err, out) => resolve(err ? null : parseWinProcs(String(out || '')))));
}

/**
 * argv of a Windows command line (CommandLineToArgvW rules: double quotes group, `\"` is a quote, other backslashes are
 * literal), with `\` turned into `/` so the agent detectors' package-path patterns match. For detection only.
 */
export function splitWindowsCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = ''; let inQ = false; let any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      let n = 0; while (line[i + n] === '\\') n++;
      if (line[i + n] === '"') { cur += '\\'.repeat(Math.floor(n / 2)); if (n % 2) { cur += '"'; i += n; } else i += n - 1; any = true; continue; }
      cur += '\\'.repeat(n); i += n - 1; any = true; continue;
    }
    if (c === '"') { inQ = !inQ; any = true; continue; }
    if (!inQ && (c === ' ' || c === '\t')) { if (any) { out.push(cur); cur = ''; any = false; } continue; }
    cur += c; any = true;
  }
  if (any) out.push(cur);
  return out.map((t) => t.replace(/\\/g, '/'));
}
