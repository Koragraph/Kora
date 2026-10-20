import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWinProcs, splitWindowsCommandLine, winProcScript } from './win-procs';
import { agentFromArgvTokens } from '../detect/agents';

test('win-procs: the CIM query covers every process, or only the asked pids', () => {
  assert.doesNotMatch(winProcScript(), /-Filter/);
  assert.match(winProcScript([12, 34.7]), /-Filter "ProcessId=12 OR ProcessId=34"/);
  assert.match(winProcScript(), /Get-CimInstance Win32_Process/);
});

test('win-procs: rows parse (CRLF, no command line, junk lines skipped)', () => {
  const out = '4\t0\t\t\r\n1200\t4\t2026-10-15T08:00:00.1234560Z\t"C:\\Program Files\\nodejs\\node.exe" x.js\r\n\r\nWARNING: x\r\n';
  assert.deepEqual(parseWinProcs(out), [
    { pid: 4, ppid: 0, startedAt: '', commandLine: '' },
    { pid: 1200, ppid: 4, startedAt: '2026-10-15T08:00:00.1234560Z', commandLine: '"C:\\Program Files\\nodejs\\node.exe" x.js' },
  ]);
});

test('win-procs: Windows command lines split by CommandLineToArgvW rules', () => {
  assert.deepEqual(splitWindowsCommandLine('"C:\\Program Files\\x\\a.exe" -c "two words" plain'), ['C:/Program Files/x/a.exe', '-c', 'two words', 'plain']);
  assert.deepEqual(splitWindowsCommandLine('a.exe "say \\"hi\\"" ""'), ['a.exe', 'say "hi"', '']);
  assert.deepEqual(splitWindowsCommandLine('  a.exe   b  '), ['a.exe', 'b']);
});

test('win-procs: an agent is found in a Windows command line (npm shim run by node, a native exe, a shell)', () => {
  const codex = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Ann Lee\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" exec';
  assert.equal(agentFromArgvTokens(splitWindowsCommandLine(codex)), 'codex');
  assert.equal(agentFromArgvTokens(splitWindowsCommandLine('"C:\\Users\\a\\.local\\bin\\claude.exe" --resume x')), 'claude');
  assert.equal(agentFromArgvTokens(splitWindowsCommandLine('C:\\Windows\\System32\\cmd.exe /d')), null);
});
