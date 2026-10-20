// Test isolation preload: `node --require ./scripts/test-isolate.cjs --test …`. node --test forwards --require to
// every test-file child process, so EACH FILE gets its own throwaway HOME, KORA_HOME, CODEX_HOME, graph store and
// socket. Nothing a test does can reach the real ~/.kora, ~/.claude (skills, settings), ~/.codex or
// ~/.koragraph/graph.db, and files running in parallel never share a socket, a lock dir or a state file.
// A test that needs its own paths still sets them itself (a later assignment wins).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Three kinds of process load this file: the `node --test` runner (only remembers the real home), each test-file
// child (isolates), and anything a test spawns with process.execArgv — a daemon, a graph worker. Those inherit the
// test file's environment, which may have been customised after isolation (a test's own KORAGRAPH_HOME), so they
// must NOT isolate again.

/**
 * Remove isolation bases that an earlier run left behind (deep A2-9): `--test-force-exit` can end a test file's process
 * without its `exit` handler, so 209 bases (90 MB) had piled up. A base is stale when its `.owner` pid is dead, or (no
 * `.owner`, i.e. made by an older runner) when it has not been touched for 2 hours. Never touches a live owner's base.
 */
function sweepStaleBases(parent, prefix, now = Date.now()) {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(parent); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const dir = path.join(parent, name);
    try {
      let stale;
      let owner = NaN;
      try { owner = Number(fs.readFileSync(path.join(dir, '.owner'), 'utf8').trim()); } catch { /* older base */ }
      if (Number.isInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); stale = false; } catch (e) { stale = e && e.code === 'ESRCH'; }
      } else stale = now - fs.statSync(dir).mtimeMs > 2 * 3600 * 1000;
      if (stale) { fs.rmSync(dir, { recursive: true, force: true }); removed++; }
    } catch { /* best effort */ }
  }
  return removed;
}
module.exports = { sweepStaleBases };

const isRunner = process.execArgv.includes('--test') || process.argv.includes('--test');
// The repo needs Node 24 (package.json engines). On an older node (a Homebrew 22 first on PATH) the suites that wait on an
// unref'd worker or timer do not fail: node ends the file mid-test and ~20 tests read "Promise resolution is still
// pending", which looks like a Kora bug. Say what is wrong instead.
if (isRunner && Number(process.versions.node.split('.')[0]) < 24) {
  process.stderr.write(`kora tests need Node 24 (package.json engines); this is ${process.version} at ${process.execPath}.\nPut Node 24 first on PATH (e.g. ~/.nvm/versions/node/v24.11.1/bin) and run again.\n`);
  process.exit(1);
}
// oxlint-disable-next-line kora/no-posix-only-paths -- existsSync is false on Windows (no C:\tmp), so os.tmpdir() is used there
if (isRunner) { process.env.KORA_TEST_REAL_HOME ||= os.homedir(); sweepStaleBases(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'kt-'); }
else if (!process.env.KORA_TEST_NO_ISOLATE && !process.env.KORA_TEST_ISOLATED) {
  const realHome = process.env.KORA_TEST_REAL_HOME || os.homedir();
  // Short base: macOS caps unix-socket paths at 104 bytes and os.tmpdir() is already ~50.
  // Windows: os.tmpdir() may be an 8.3 short name (C:\Users\RUNNER~1\…) while realpath gives the long one; start long.
  const tmpRoot = process.platform === 'win32' ? fs.realpathSync.native(os.tmpdir()) : fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
  const base = fs.mkdtempSync(path.join(tmpRoot, 'kt-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  try { fs.writeFileSync(path.join(base, '.owner'), String(process.pid)); } catch { /* sweep falls back to age */ }
  // Keep the developer's git defaults (init.defaultBranch, identity) — read-only copy.
  try { fs.copyFileSync(path.join(realHome, '.gitconfig'), path.join(home, '.gitconfig')); } catch { /* none */ }
  const env = process.env;
  env.KORA_TEST_REAL_HOME = realHome;
  env.KORA_TEST_BASE = base;
  env.KORA_TEST_ISOLATED = String(process.pid);
  env.HOME = home;
  env.KORA_HOME = path.join(home, '.kora');
  env.CODEX_HOME = path.join(home, '.codex');
  env.KORAGRAPH_HOME = path.join(home, '.koragraph');
  env.KORAGRAPH_DB = path.join(home, '.koragraph', 'graph.db');
  env.KORA_SOCKET_PATH = path.join(base, 'k.sock');
  // os.tmpdir() too: tests' mkdtemp fixtures (repos, stores, markers) landed in the shared $TMPDIR and a leaked one was
  // never removed — measured ~175 MB of kora-*/sw-* litter after a day of runs. Under base they go with it at exit.
  env.TMPDIR = path.join(base, 'tmp'); fs.mkdirSync(env.TMPDIR, { recursive: true });
  // Windows reads the home from USERPROFILE (os.homedir ignores HOME) and the temp dir from TEMP/TMP.
  if (process.platform === 'win32') {
    env.USERPROFILE = home; env.TEMP = env.TMP = env.TMPDIR;
    env.APPDATA = path.join(home, 'AppData', 'Roaming'); env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
    fs.mkdirSync(env.APPDATA, { recursive: true }); fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  }
  // The blob suites test Kora itself, so they run with the Kora surface on (edition.ts); the coming-soon gate tests
  // switch it off with setKoraSurfaceForTests / a BlobRuntime `surfaceOn` of their own.
  env.KORA_SURFACE ||= 'on';
  env.KORA_UI_PORT = '0';               // a test daemon never binds the real UI port
  // A run inside a Kora session inherits that session's lane settings; they point at real state or switch lanes off
  // (KORA_BLOBS_ROOT failed the blob-lane savings test, KORA_INJECT_OWNER=driver the hook tests).
  delete env.KORA_BLOBS_ROOT; delete env.KORA_INJECT_OWNER;
  env.KORAGRAPH_INGEST_NO_HOOKS = '1';  // a fixture ingest writes no git/Claude hooks (each would be a fresh executable on its first run)
  env.KORA_LEGACY_HOME = path.join(home, '.nhands'); // takeover's legacy-home lookups read a temp dir, never the real ~/.nhands
  env.GIT_AUTHOR_NAME ||= 'kora-test'; env.GIT_AUTHOR_EMAIL ||= 'kora-test@example.invalid';
  env.GIT_COMMITTER_NAME ||= 'kora-test'; env.GIT_COMMITTER_EMAIL ||= 'kora-test@example.invalid';
  const owner = process.pid;
  process.on('exit', () => { if (process.pid !== owner) return; if (!env.KORA_TEST_KEEP) { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ } } });
}
