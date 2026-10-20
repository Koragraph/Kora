// Multiple Claude accounts (Phase 7): named accounts, each with its OWN CLAUDE_CONFIG_DIR. A blob/thread picks one by name
// (SessionStartInput.account, already plumbed to the Claude driver's env); the header shows it. Rules:
//   - Kora never copies, moves or reads an existing login. A new account is an EMPTY config dir and the user signs in
//     themselves with the command shown (`CLAUDE_CONFIG_DIR=<dir> claude auth login`).
//   - Only CLAUDE_CONFIG_DIR is set. NEVER HOME (a fake HOME makes the keychain vanish and Claude writes its OAuth token
//     to a plaintext file - CLAUDE.md "Fake HOME keychain hazard").
//   - No auto-rotation: a rate-limited account stays the account; the user switches by hand. There is deliberately no
//     "next account" function in this file.
// Storage: <KORA_HOME>/claude-accounts.json {accounts:[{name,label,configDir,createdAt}]}. The default account is "no name"
// (the user's ~/.claude) and is not stored.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { winCommand } from '../util/win-exec';
import { koraHome } from '../protocol/types';

export interface ClaudeAccount { name: string; label: string; configDir: string; createdAt: number }
export type AccountSignIn = 'signed-in' | 'signed-out' | 'unknown';
export interface ClaudeAccountView extends ClaudeAccount { signIn: AccountSignIn; email?: string; signInCommand: string }

const NAME = /^[a-z0-9][a-z0-9-]{0,29}$/;

/** `export CLAUDE_CONFIG_DIR='…'; claude auth login` quoted for a shell. */
export function shellQuote(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }
/**
 * The command the user pastes to sign an account in. Windows: PowerShell (the default terminal there; Claude Code keeps
 * that login in `<configDir>\.credentials.json`, not in Credential Manager), where `'` doubles inside single quotes.
 */
export function signInCommand(configDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `$env:CLAUDE_CONFIG_DIR='${configDir.replace(/'/g, "''")}'; claude auth login`;
  return `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} claude auth login`;
}

export function defaultConfigDir(name: string, home = koraHome()): string { return path.join(home, 'accounts', 'claude', name); }

export type StatusRunner = (configDir: string) => Promise<{ code: number; stdout: string }>;
/** `claude auth status --json` with ONLY CLAUDE_CONFIG_DIR changed. Read-only; never opens a browser. */
export const runClaudeAuthStatus: StatusRunner = (configDir) => new Promise((resolve) => {
  try {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
    const w = winCommand('claude', ['auth', 'status', '--json'], env);
    execFile(w.command, w.args, { timeout: 15_000, env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: w.windowsVerbatimArguments }, (err, stdout) => {
      resolve({ code: err ? ((err as any).code && typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, stdout: String(stdout ?? '') });
    });
  } catch { resolve({ code: 127, stdout: '' }); }
});

export class ClaudeAccounts {
  constructor(private o: { file?: string; home?: string; status?: StatusRunner } = {}) {}
  private get home(): string { return this.o.home ?? koraHome(); }
  private get file(): string { return this.o.file ?? path.join(this.home, 'claude-accounts.json'); }

  list(): ClaudeAccount[] {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return (Array.isArray(j?.accounts) ? j.accounts : []).filter((a: any) => a && NAME.test(String(a.name)) && typeof a.configDir === 'string' && path.isAbsolute(a.configDir))
        .map((a: any) => ({ name: String(a.name), label: String(a.label ?? a.name), configDir: String(a.configDir), createdAt: Number(a.createdAt) || 0 }));
    } catch { return []; }
  }
  get(name: string | null | undefined): ClaudeAccount | null { return name ? this.list().find((a) => a.name === name) ?? null : null; }
  private write(accounts: ClaudeAccount[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ accounts }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Add a named account with an empty config dir. `configDir` may point at an existing dir the user wants to adopt. Never copies anything. */
  add(i: { name: string; label?: string; configDir?: string }): ClaudeAccountView {
    const name = String(i.name ?? '').trim().toLowerCase();
    if (!NAME.test(name)) throw new Error('The account name may use lowercase letters, numbers and dashes (up to 30 characters).');
    const all = this.list();
    if (all.some((a) => a.name === name)) throw new Error(`An account named "${name}" already exists.`);
    const configDir = path.resolve(i.configDir?.trim() ? i.configDir.replace(/^~(?=$|\/)/, os.homedir()) : defaultConfigDir(name, this.home));
    const defaultClaude = path.join(os.homedir(), '.claude');
    if (configDir === defaultClaude || configDir === os.homedir()) throw new Error('That is your main Claude login (the default account). Named accounts need their own, separate folder.');
    if (all.some((a) => a.configDir === configDir)) throw new Error('Another account already uses that folder.');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const acct: ClaudeAccount = { name, label: (i.label?.trim() || name).slice(0, 40), configDir, createdAt: Date.now() };
    this.write([...all, acct]);
    return { ...acct, signIn: 'unknown', signInCommand: signInCommand(configDir) };
  }

  /**
   * Forget the account and delete its config folder (its saved login file and settings) when Kora made that folder:
   * only a folder strictly inside <KORA_HOME>/accounts/claude is ever removed (path-checked on the realpath). An
   * adopted folder elsewhere is left as it was. A login Claude saved in the macOS Keychain is not touched (Kora never
   * opens the keychain): the UI tells the user to `claude auth logout` first (pl9 S2-2).
   */
  remove(name: string): boolean {
    const all = this.list(); const gone = all.find((a) => a.name === name); const next = all.filter((a) => a.name !== name);
    if (!gone) return false;
    this.write(next);
    try {
      const root = fs.realpathSync(path.join(this.home, 'accounts', 'claude'));
      const dir = fs.realpathSync(gone.configDir);
      if (dir.startsWith(root + path.sep) && path.dirname(dir) === root && !next.some((a) => path.resolve(a.configDir) === path.resolve(gone.configDir))) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch { /* no folder (never created / already gone): nothing to delete */ }
    return true;
  }

  rename(name: string, label: string): boolean {
    const all = this.list(); const a = all.find((x) => x.name === name);
    if (!a) return false;
    a.label = label.trim().slice(0, 40) || a.name;
    this.write(all);
    return true;
  }

  /** The env a Claude process of this account gets: CLAUDE_CONFIG_DIR only. Unknown/null account -> {} (the default login). */
  env(name: string | null | undefined): Record<string, string> {
    const a = this.get(name);
    if (a) return { CLAUDE_CONFIG_DIR: a.configDir };
    // An unregistered name keeps the pre-Phase-7 convention (<KORA_HOME>/accounts/claude/<name>) so old threads still resolve.
    return name && NAME.test(name) ? { CLAUDE_CONFIG_DIR: defaultConfigDir(name, this.home) } : {};
  }

  /** Signed in or not, by asking the CLI about that dir. Read-only. */
  async status(name: string): Promise<{ signIn: AccountSignIn; email?: string }> {
    const a = this.get(name);
    if (!a) return { signIn: 'unknown' };
    const r = await (this.o.status ?? runClaudeAuthStatus)(a.configDir);
    try {
      const j = JSON.parse(r.stdout);
      const ok = j?.loggedIn === true || j?.authenticated === true || (j?.loggedIn === undefined && r.code === 0 && !!(j?.email || j?.account));
      const email = j?.email ?? j?.account?.email ?? j?.emailAddress;
      return { signIn: ok ? 'signed-in' : 'signed-out', ...(typeof email === 'string' ? { email } : {}) };
    } catch { return { signIn: r.code === 0 ? 'unknown' : 'signed-out' }; }
  }

  /** Everything Settings > Engines shows for the Claude accounts section. */
  async view(): Promise<ClaudeAccountView[]> {
    return Promise.all(this.list().map(async (a) => ({ ...a, ...(await this.status(a.name).catch(() => ({ signIn: 'unknown' as const }))), signInCommand: signInCommand(a.configDir) })));
  }
}

/** The label for the header chip: the account's label, or null for the default login (nothing to show). */
export function accountChipLabel(accounts: ClaudeAccount[], name: string | null | undefined): string | null {
  if (!name) return null;
  return accounts.find((a) => a.name === name)?.label ?? name;
}
