// Tiny argv parser for the graph/enforce/setup commands: `--key value`, `--key=value`, `--flag`,
// `--no-flag`, positionals. No dependency, no surprises.
export interface Parsed { flags: Record<string, string | boolean>; positional: string[] }

export function parseArgs(argv: string[], valueFlags: string[] = []): Parsed {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      if (key.startsWith('no-') && !valueFlags.includes(key)) { flags[key.slice(3)] = false; flags[key] = true; continue; }
      const next = argv[i + 1];
      if (valueFlags.includes(key) && next !== undefined) { flags[key] = next; i++; continue; }
      if (!valueFlags.includes(key) && next !== undefined && !next.startsWith('-') && !KNOWN_BOOL.has(key)) { flags[key] = next; i++; continue; }
      flags[key] = true;
      continue;
    }
    positional.push(a);
  }
  return { flags, positional };
}

const KNOWN_BOOL = new Set(['json', 'full', 'wait', 'help', 'create', 'ingest', 'git-hooks', 'shims', 'replace-koragraph-hooks', 'verbose', 'dry-run', 'all-known', 'home', 'install', 'purge', 'yes']);

export function str(v: string | boolean | undefined): string | undefined { return typeof v === 'string' ? v : undefined; }
export function num(v: string | boolean | undefined): number | undefined { const n = typeof v === 'string' ? Number(v) : NaN; return Number.isFinite(n) ? n : undefined; }
