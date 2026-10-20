// The base environment a spawned pane inherits from the daemon, per trust level.
//
//   'inherit'  — shell panes and orchestrator workers (the user's OWN claude/codex/gemini CLIs, launched exactly as the
//                user would launch them in a terminal). They keep the daemon's env: they authenticate with the user's
//                own credentials (ANTHROPIC_API_KEY, OPENAI_API_KEY, gh/aws profiles…) and run the user's own tooling.
//                Only the markers of a parent agent session are dropped. A deliberate choice, not an oversight.
//   'isolated' — Swarm workers: OpenCode driving THIRD-PARTY free models. A prompt-injected or misbehaving model must not
//                find the user's cloud / git / LLM credentials in `env`. Allowlist only: the locale, terminal, paths
//                and toolchain homes a build needs, proxy settings, KORA_* identity. Its provider key is added by
//                swarmPaneEnv (params.env) for THAT provider only — never inherited from here.
//
// This is defence in depth, not a sandbox: a worker with a shell can still read files under $HOME. Its file tools are
// fenced to the worktree by OpenCode's `external_directory: deny` (swarm-opencode.ts).
import path from 'node:path';
import { isKoraOwnSecret } from '../util/child-env';

export type EnvPolicy = 'inherit' | 'isolated';

/** A parent agent session's markers: a child agent must not inherit them (Claude Code turns transcripts off, etc.). */
const SESSION_MARKER = /^(CLAUDE_CODE_|CLAUDECODE|CODEX_SANDBOX|KORA_PANE_ID$|KORA_AGENT$)/;

/** Exact names an isolated worker keeps. */
const ISOLATED_KEEP = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'PWD',
  'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM', 'TERM_PROGRAM', 'NO_COLOR', 'FORCE_COLOR', 'EDITOR', 'VISUAL', 'PAGER',
  '__CF_USER_TEXT_ENCODING',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  // Toolchain homes a build/test run resolves binaries or caches through (paths, never credentials).
  'NVM_DIR', 'NVM_BIN', 'VOLTA_HOME', 'PNPM_HOME', 'BUN_INSTALL', 'DENO_DIR', 'COREPACK_HOME', 'NODE_PATH',
  'GOPATH', 'GOROOT', 'GOBIN', 'CARGO_HOME', 'RUSTUP_HOME', 'JAVA_HOME', 'ANDROID_HOME', 'PYENV_ROOT', 'PYTHONPATH',
  'VIRTUAL_ENV', 'CONDA_PREFIX', 'RBENV_ROOT', 'GEM_HOME', 'GEM_PATH', 'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR',
  'HOMEBREW_REPOSITORY', 'DEVELOPER_DIR', 'SDKROOT',
  // Network plumbing a corporate machine needs to reach any provider at all.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
  'KORAGRAPH_DB', 'KORAGRAPH_HOME',
  // Koragent's own home and catalog override (paths / a URL; its provider keys come from params.env, never from here).
  'KORAGENT_HOME', 'KORAGENT_MODELS_URL',
]);
/**
 * Windows: the variables programs need to start at all (no SystemRoot = Winsock/crypto fail in node, git, …) and the
 * profile folders tools find their config in. Windows env names are case-insensitive (`Path`), so compared upper-case.
 */
const ISOLATED_KEEP_WINDOWS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'OS', 'USERPROFILE', 'USERNAME', 'USERDOMAIN',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'ALLUSERSPROFILE', 'PUBLIC', 'COMPUTERNAME',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS', 'PSMODULEPATH', 'TEMP', 'TMP',
]);
/** Prefixes an isolated worker keeps: locale, and Kora's own non-secret identity/config vars. */
const ISOLATED_KEEP_PREFIX = /^(LC_|KORA_)/;
/** Never kept even when a prefix matches (Kora vars that could carry a credential). */
const ISOLATED_DROP = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|AUTH)/i;

/** The env a pane starts from (before Kora's own KORA_* / TERM / params.env additions). */
export function baseEnv(src: NodeJS.ProcessEnv, policy: EnvPolicy): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    // Kora's own secrets (a KORA_*_TOKEN, release-signing secrets) never reach any pane, whatever its policy.
    if (v === undefined || SESSION_MARKER.test(k) || isKoraOwnSecret(k)) continue;
    if (policy === 'isolated') {
      const keep = ISOLATED_KEEP.has(k) || ISOLATED_KEEP_PREFIX.test(k) || (process.platform === 'win32' && ISOLATED_KEEP_WINDOWS.has(k.toUpperCase()));
      if (!keep || (ISOLATED_DROP.test(k) && !ISOLATED_KEEP.has(k))) continue;
    }
    out[k] = v;
  }
  // The daemon is started by the app with a minimal PATH: give panes the node that runs the daemon so a worker can run tests.
  const nodeDir = path.dirname(process.execPath);
  const pk = Object.keys(out).find((k) => k.toUpperCase() === 'PATH'); // Windows spells it `Path`
  if (pk && !out[pk]!.split(path.delimiter).includes(nodeDir)) out[pk] = `${out[pk]}${path.delimiter}${nodeDir}`;
  return out;
}
