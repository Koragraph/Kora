// `kora trim-run [--home H] [--thread T] [--min N] -- <program> <args…>`: run a test / build command unchanged and print its output
// trimmed (session/trim-run.ts). Not typed by a person: the chat lane's PreToolUse hook puts it in front of a recognised runner
// when Bash trim is "on". Any option error runs nothing and exits 2 (the hook only builds well-formed lines).
import type { IO } from '../main';

export const summary = 'Run a command unchanged and print its output trimmed (internal: the Bash trim wrapper)';
export const usage = 'Usage: kora trim-run [--home <dir>] [--thread <id>] [--min <chars>] -- <program> [args…]';

export async function run(argv: string[], io: IO): Promise<number> {
  const dash = argv.indexOf('--');
  if (dash < 0 || dash === argv.length - 1) { io.err(`${usage}\n`); return 2; }
  const opt = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 && i < dash ? argv[i + 1] : undefined; };
  const { koraHome } = require('../../protocol/types') as typeof import('../../protocol/types');
  const { runTrimmed } = require('../../session/trim-run') as typeof import('../../session/trim-run');
  const min = Number(opt('--min'));
  return runTrimmed({
    argv: argv.slice(dash + 1),
    home: opt('--home') || koraHome(),
    thread: opt('--thread') || 'run',
    ...(Number.isFinite(min) && opt('--min') !== undefined ? { minChars: min } : {}),
  });
}
