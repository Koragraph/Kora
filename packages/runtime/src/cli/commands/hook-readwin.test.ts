// The pane's bounded-Read state file under parallel Reads: Claude Code runs several Reads at once, and each one's
// `kora hook pre-tool` process loads, decides and saves the same state file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundForPane, loadReadWin, markerBase, postTool, saveReadWin } from './hook';

test('boundForPane: parallel Reads in one session each keep their seen mark (no lost update)', async () => {
  delete process.env.KORA_INJECT_OWNER;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-readwin-'));
  const body = Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  for (const f of ['a.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(cwd, f), body);
  const session_id = `race-${process.pid}-${Date.now()}`;
  const read = (f: string) => ({ tool_name: 'Read', session_id, cwd, tool_input: { file_path: path.join(cwd, f) } });
  await Promise.all(['a.ts', 'b.ts', 'c.ts'].map((f) => boundForPane(read(f))));
  const seen = loadReadWin(markerBase({ session_id })).seen.map((p) => path.basename(p)).sort();
  assert.deepEqual(seen, ['a.ts', 'b.ts', 'c.ts'], 'a lost seen mark means the next whole Read of that file is bounded again');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('postTool: a Bash cat of a bounded file drops its credit in the pane lane too (read-expand)', async () => {
  delete process.env.KORA_INJECT_OWNER;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-readwin-home-'));
  const prevHome = process.env.KORA_HOME; process.env.KORA_HOME = home;
  try {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-readwin-'));
    const file = path.join(cwd, 'big.ts');
    const session_id = `expand-${process.pid}-${Date.now()}`;
    const base = markerBase({ session_id });
    const st = loadReadWin(base);
    st.bounded.push({ path: file, turn: st.turn, offset: 1, limit: 80, total: 900, source: 'explore' });
    saveReadWin(base, st);
    postTool({ tool_name: 'Bash', hook_event_name: 'PostToolUse', session_id, cwd, tool_input: { command: 'sed -n 1,400p big.ts' } });
    const after = loadReadWin(base);
    assert.equal(after.bounded.find((b) => b.path === file)?.expanded, true, 'the bound is marked expanded');
    const log = fs.readFileSync(path.join(home, 'cost.jsonl'), 'utf8');
    assert.match(log, /"k":"read-expand"[^\n]*"file":"big.ts"/);
    fs.rmSync(cwd, { recursive: true, force: true });
  } finally {
    if (prevHome === undefined) delete process.env.KORA_HOME; else process.env.KORA_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
