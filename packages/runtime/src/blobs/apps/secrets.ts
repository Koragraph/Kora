// Where the BYO Composio key (and the broker token) live. Not in profile.json, not in env, not in logs.
// The daemon outlives the app, so it needs its own access: macOS Keychain via `security -i`, Windows Credential Manager
// via PowerShell + advapi32 Cred* (no native module), else a 0600 file. The value always goes over stdin, never argv or
// env. The desktop can inject Electron safeStorage by implementing SecretStore (WIRING.md).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { koraHome } from '../../protocol/types';

export interface SecretStore {
  readonly kind: string;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const NAME = /^[a-z0-9-]{1,40}$/;
const VALUE = /^[A-Za-z0-9_.\-]{8,400}$/; // Composio keys and our tokens: keeps the keychain command injection-proof
// Any other provider key (sk-ant-..., keys with + / = ~ etc.): printable ASCII without spaces, sent hex-encoded (`-X`), so no character can reach the command parser.
const PRINTABLE = /^[\x21-\x7e]{8,2000}$/;

export class MemorySecretStore implements SecretStore {
  readonly kind = 'memory';
  private m = new Map<string, string>();
  async get(n: string) { return this.m.get(n) ?? null; }
  async set(n: string, v: string) { this.m.set(n, v); }
  async delete(n: string) { this.m.delete(n); }
}

export class FileSecretStore implements SecretStore {
  readonly kind = 'file';
  constructor(private readonly dir: string) {}
  private p(n: string) { if (!NAME.test(n)) throw new Error('bad secret name'); return path.join(this.dir, n); }
  async get(n: string) { try { return fs.readFileSync(this.p(n), 'utf8').trim() || null; } catch { return null; } }
  async set(n: string, v: string) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = this.p(n) + '.tmp';
    fs.writeFileSync(tmp, v, { mode: 0o600 });
    fs.renameSync(tmp, this.p(n));
  }
  async delete(n: string) { try { fs.unlinkSync(this.p(n)); } catch { /* already gone */ } }
}

export type SecurityRunner = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>;
const runSecurity: SecurityRunner = (args, stdin) => new Promise((resolve) => {
  const c = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('error', () => resolve({ code: 127, stdout: '' }));
  c.on('close', (code) => resolve({ code: code ?? 1, stdout: out }));
  c.stdin.end(stdin ?? '');
});

export class KeychainSecretStore implements SecretStore {
  readonly kind = 'keychain';
  constructor(private readonly service = 'kora-apps', private readonly run: SecurityRunner = runSecurity) {}
  async get(n: string) {
    if (!NAME.test(n)) throw new Error('bad secret name');
    const r = await this.run(['find-generic-password', '-s', this.service, '-a', n, '-w']);
    return r.code === 0 ? r.stdout.trim() || null : null;
  }
  async set(n: string, v: string) {
    if (!NAME.test(n)) throw new Error('bad secret name');
    if (!PRINTABLE.test(v)) throw new Error('that does not look like a valid key');
    const data = VALUE.test(v) ? `-w ${v}` : `-X ${Buffer.from(v, 'utf8').toString('hex')}`;
    const r = await this.run(['-i'], `add-generic-password -U -s ${this.service} -a ${n} ${data}\n`);
    if (r.code !== 0) throw new Error('could not save to the macOS Keychain');
  }
  async delete(n: string) { if (NAME.test(n)) await this.run(['delete-generic-password', '-s', this.service, '-a', n]); }
}

/**
 * The Keychain service for this home: `kora-apps` for the real install (`~/.kora`), `kora-apps-dev` for Kora Dev (`~/.kora-dev`),
 * `kora-apps-<hash of the path>` for anything else (a QA stack, a test), so a flavor never reads or overwrites another's
 * broker token or Composio key.
 */
export function keychainService(home: string = koraHome()): string {
  const base = path.basename(home);
  if (base === '.kora') return 'kora-apps';
  if (/^\.kora-[a-z0-9-]{1,24}$/.test(base)) return `kora-apps-${base.slice(6)}`; // Kora Dev's `.kora-dev` -> kora-apps-dev
  // anything else (a QA stack's `.../stack2/home`, a test's temp dir): its own service, named by the path
  return `kora-apps-${crypto.createHash('sha1').update(path.resolve(home)).digest('hex').slice(0, 10)}`;
}

/**
 * Windows Credential Manager (generic credentials, target `<service>/<name>`, persisted per user on this machine), the
 * counterpart of the macOS Keychain item. No native module: one PowerShell per call P/Invokes advapi32's CredReadW /
 * CredWriteW / CredDeleteW. The script is fixed text (-EncodedCommand), the target arrives in env, and the value travels
 * base64 over stdin/stdout only. The blob is the value's UTF-8 bytes (Windows caps a blob at 2560 bytes; PRINTABLE caps
 * a value at 2000). Exit 3 = not found, 4 = the API refused.
 */
export const CRED_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -Namespace KoraCred -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags; public int Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
  public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredDeleteW(string target, int type, int flags);
[DllImport("advapi32.dll")]
public static extern void CredFree(IntPtr cred);
'@
$M = [Runtime.InteropServices.Marshal]
$t = $env:KORA_CRED_TARGET
switch ($env:KORA_CRED_OP) {
  'get' {
    $p = [IntPtr]::Zero
    if (-not [KoraCred.Native]::CredReadW($t, 1, 0, [ref]$p)) { if ($M::GetLastWin32Error() -eq 1168) { exit 3 }; exit 4 }
    try {
      $c = $M::PtrToStructure($p, [type][KoraCred.Native+CREDENTIAL])
      $b = New-Object byte[] $c.CredentialBlobSize
      if ($c.CredentialBlobSize -gt 0) { $M::Copy($c.CredentialBlob, $b, 0, $c.CredentialBlobSize) }
      [Console]::Out.Write([Convert]::ToBase64String($b))
    } finally { [KoraCred.Native]::CredFree($p) }
    exit 0
  }
  'set' {
    $b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
    $h = $M::AllocHGlobal($b.Length)
    try {
      $M::Copy($b, 0, $h, $b.Length)
      $c = New-Object KoraCred.Native+CREDENTIAL
      $c.Type = 1; $c.Persist = 2; $c.TargetName = $t; $c.UserName = $env:KORA_CRED_USER
      $c.CredentialBlobSize = $b.Length; $c.CredentialBlob = $h
      if (-not [KoraCred.Native]::CredWriteW([ref]$c, 0)) { exit 4 }
    } finally { $M::Copy((New-Object byte[] $b.Length), 0, $h, $b.Length); $M::FreeHGlobal($h); [Array]::Clear($b, 0, $b.Length) }
    exit 0
  }
  'delete' {
    if (-not [KoraCred.Native]::CredDeleteW($t, 1, 0)) { if ($M::GetLastWin32Error() -eq 1168) { exit 0 }; exit 4 }
    exit 0
  }
}
exit 2
`;

export type CredOp = 'get' | 'set' | 'delete';
export type CredRunner = (op: CredOp, target: string, user: string, stdin?: string) => Promise<{ code: number; stdout: string }>;
const CRED_TIMEOUT_MS = 20_000; // Add-Type compiles the P/Invoke class: 1-3 s on a cold machine
const runCred: CredRunner = (op, target, user, stdin) => new Promise((resolve) => {
  // The system PowerShell by full path: a `powershell.exe` earlier on PATH (a repo's folder) must never get the value.
  const ps = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(CRED_SCRIPT, 'utf16le').toString('base64');
  let c: ReturnType<typeof spawn>;
  try {
    c = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      env: { ...process.env, KORA_CRED_OP: op, KORA_CRED_TARGET: target, KORA_CRED_USER: user },
    });
  } catch { resolve({ code: 127, stdout: '' }); return; }
  let out = '';
  const timer = setTimeout(() => { try { c.kill(); } catch { /* gone */ } }, CRED_TIMEOUT_MS);
  c.stdout!.on('data', (d) => { out += d; });
  c.on('error', () => { clearTimeout(timer); resolve({ code: 127, stdout: '' }); });
  c.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: out }); });
  c.stdin!.end(stdin ?? '');
});

export class WindowsCredentialSecretStore implements SecretStore {
  readonly kind = 'credman';
  constructor(private readonly service = 'kora-apps', private readonly run: CredRunner = runCred) {}
  private target(n: string) { if (!NAME.test(n)) throw new Error('bad secret name'); return `${this.service}/${n}`; }
  async get(n: string) {
    const r = await this.run('get', this.target(n), n);
    if (r.code !== 0) return null;
    const v = Buffer.from(r.stdout.trim(), 'base64').toString('utf8').trim();
    return v || null;
  }
  async set(n: string, v: string) {
    const target = this.target(n);
    if (!PRINTABLE.test(v)) throw new Error('that does not look like a valid key');
    const r = await this.run('set', target, n, Buffer.from(v, 'utf8').toString('base64'));
    if (r.code !== 0) throw new Error('could not save to Windows Credential Manager');
  }
  async delete(n: string) { if (NAME.test(n)) await this.run('delete', this.target(n), n); }
}

/** The OS store first, a 0600 file when it refuses (a locked keychain, a policy that blocks PowerShell). */
function withFileFallback(primary: SecretStore, file: FileSecretStore): SecretStore {
  return {
    kind: `${primary.kind}+file`,
    async get(n) { return (await primary.get(n).catch(() => null)) ?? (await file.get(n)); },
    async set(n, v) { try { await primary.set(n, v); await file.delete(n); } catch { await file.set(n, v); } },
    async delete(n) { await primary.delete(n).catch(() => undefined); await file.delete(n); },
  };
}

/**
 * Keychain on macOS, Credential Manager on Windows (each falling back to a 0600 file when the OS store refuses), a 0600
 * file elsewhere. `KORA_APPS_VAULT=file` forces the file (the QA stacks and tests: they must never touch the user's
 * Keychain or Credential Manager). Both OS stores share the per-home service name (`keychainService`).
 */
export function defaultSecretStore(dir: string, platform: NodeJS.Platform = process.platform): SecretStore {
  const file = new FileSecretStore(dir);
  if (process.env.KORA_APPS_VAULT === 'file') return file;
  if (platform === 'darwin') return withFileFallback(new KeychainSecretStore(keychainService()), file);
  if (platform === 'win32') return withFileFallback(new WindowsCredentialSecretStore(keychainService()), file);
  return file;
}
