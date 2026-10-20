'use strict';
// explore's `callers:` line carries each caller's call site (2026-10-02 chat-lane bench: with only the caller's own
// declaration line, every "list the call sites, file:line" task re-grepped for lines the CALLS edges already store).
const test = require('node:test');
const assert = require('node:assert');
const { renderCallerRefs } = require('../src/mcp/tool-handlers');

test('callers line names the call line, merges sites of one caller, never adds a comma inside a ref', () => {
  const out = renderCallerRefs([
    { name: 'neighbours', file: 'src/mcp/tool-handlers.js', line: 378, call_line: 394 },
    { name: 'changesWith', file: 'src/mcp/tool-handlers.js', line: 479, call_line: 492 },
    { name: 'changesWith', file: 'src/mcp/tool-handlers.js', line: 479, call_line: 510 },
    { name: 'run', file: 'src/cli/cochange.js', line: 72 },
  ]);
  assert.strictEqual(out, 'neighbours@src/mcp/tool-handlers.js:378 (call at :394), changesWith@src/mcp/tool-handlers.js:479 (call at :492/:510), run@src/cli/cochange.js:72');
  assert.strictEqual(out.split(/,\s*/).length, 3, 'one comma-separated ref per caller');
});

test('explore: a 1-3 line function the query NAMES leads the focus (not demoted as a trivial getter); a plain-word getter still is', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kg-explore-')));
  const env = { ...process.env, KORAGRAPH_HOME: path.join(TMP, 'home') }; delete env.KORAGRAPH_DB; delete env.KORAGRAPH_PRACTICE_DB;
  const CLI = path.resolve(__dirname, '..', 'bin', 'koragraph.js');
  const r = path.join(TMP, 'repo'); fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.writeFileSync(path.join(r, 'src', 'watch.js'), [
    'function signatureOf(c) {', '  return `${c.head}|${c.changed.join(",")}`;', '}',
    'function errorSignatureOf(json) {', '  try {', '    const e = JSON.parse(json || "{}");', '    return e.err_signature || null;', '  } catch {', '    return null;', '  }', '}',
    'function tick(state, change) {', '  const sig = signatureOf(change);', '  if (sig === state.last) return false;', '  state.last = sig;', '  return errorSignatureOf(state.err) == null;', '}',
    'module.exports = { signatureOf, errorSignatureOf, tick };', '',
  ].join('\n'));
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: r, stdio: 'pipe' });
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'init');
  try {
    execFileSync(process.execPath, [CLI, 'ingest', r, '--no-hooks'], { env, stdio: 'pipe' });
    // the explore handler in a child (its store opens from KORAGRAPH_HOME at first use)
    const H = path.resolve(__dirname, '..', 'src', 'mcp', 'tool-handlers.js');
    const out = execFileSync(process.execPath, ['-e', `require(${JSON.stringify(H)}).explore({ query: 'Which functions call signatureOf?' }, { cwd: ${JSON.stringify(r)} }).then((x) => { process.stdout.write(x.text); process.exit(0); }, (e) => { console.error(e); process.exit(1); })`], { cwd: r, env, encoding: 'utf8' });
    const first = (out.split('\n').find((l) => l.startsWith('■')) || '');
    assert.match(first, /■ \w+ signatureOf @ src\/watch\.js:1\b/, out);
    assert.match(out, /callers: tick@src\/watch\.js:12 \(call at :13\)/, out);
  } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
});
