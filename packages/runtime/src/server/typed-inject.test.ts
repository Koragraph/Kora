// Agents without a prompt hook get graph declarations TYPED ahead of the prompt (workspace.ts prompt()). Real store
// (a fixture repo ingested into a temp graph.db), real runtime, a `cat` pane standing in for the agent: whatever the
// runtime types is echoed back, so the screen shows exactly what an agent's composer would receive.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nh-typed-'));
process.env.KORA_HOME = home; process.env.KORA_SOCKET_PATH = path.join(home, 's.sock');
process.env.KORA_AUTO_INGEST = '0'; process.env.KORA_AUTO_SETUP = '0'; process.env.KORA_WORKTREES = path.join(home, 'wt');
process.env.KORAGRAPH_HOME = path.join(home, 'kg'); fs.mkdirSync(process.env.KORAGRAPH_HOME, { recursive: true });
delete process.env.KORAGRAPH_DB; delete process.env.KORAGRAPH_PRACTICE_DB;
process.env.KORA_TYPED_INJECT = 'shell'; // the fixture agent is a shell running `cat`
process.env.KORA_INJECT_LOG = '0';
const git = (cwd: string, ...a: string[]) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

test('a hook-less agent pane receives the graph declarations ahead of its prompt, as one bracketed paste', async () => {
  const repo = path.join(home, 'app'); fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/pricing.js'), 'export function computeTotalPrice(items) {\n  return items.reduce((a, i) => a + i.price, 0);\n}\n');
  fs.writeFileSync(path.join(repo, 'src/cart.js'), "import { computeTotalPrice } from './pricing.js';\nexport const checkout = (items) => computeTotalPrice(items);\n");
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'add', '.'); git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  const kg = path.resolve(__dirname, '..', '..', 'koragraph', 'bin', 'koragraph.js');
  const ing = spawnSync('node', [kg, 'ingest', repo], { env: process.env, encoding: 'utf8' }); assert.equal(ing.status, 0, ing.stderr);
  const { createServer } = require('./daemon');
  const h = await createServer({ socketPath: process.env.KORA_SOCKET_PATH, restore: false, sweep: false });
  try {
    const st = await h.runtime.graph.status(repo); assert.equal(st.indexed, true, 'fixture indexed');
    const pane = await h.runtime.spawnPane({ command: 'cat', args: [], cwd: repo, agent: 'shell' as any, name: 'fake-agent' });
    const until = async (id: string, re: RegExp) => { const t0 = Date.now(); let t = ''; while (Date.now() - t0 < 15000) { t = h.runtime.requirePane(id).read('scrollback', 'text', 80); if (re.test(t)) return t; await new Promise((r) => setTimeout(r, 100)); } return t; };
    await new Promise((r) => setTimeout(r, 300));
    // The injection gives graph.status 1 s. Under the monorepo-wide parallel `pnpm test` the pane spawn above can
    // outlast the 10 s status cache, and a cold status on a starved CPU missed that budget: re-warm it here.
    // …for the path the injection will use: the pane's live cwd is the realpath (/private/var/…), a separate cache key.
    await h.runtime.graph.status(repo); await h.runtime.graph.status(fs.realpathSync(repo));
    await h.runtime.prompt(pane.id, 'how does computeTotalPrice work?', true, false, 5000);
    const text = await until(pane.id, /how does computeTotalPrice work\?[\s\S]*how does computeTotalPrice work\?|resolved from the graph/);
    const rec0 = require('../graph/prompt-inject').lastInjectRecord;
    assert.match(text, /Graph, for this prompt/, `declarations were typed (inject record ${JSON.stringify(rec0)}):\n${text}`);
    assert.match(text, /computeTotalPrice @ src\/pricing\.js:1/, text);
    assert.ok(text.indexOf('Graph, for this prompt') < text.indexOf('how does computeTotalPrice work?'), 'declarations precede the prompt');
    const rec = require('../graph/prompt-inject').lastInjectRecord;
    assert.equal(rec && rec.lane, 'pane-typed');
    process.env.KORA_TYPED_INJECT = '0';
    const pane2 = await h.runtime.spawnPane({ command: 'cat', args: [], cwd: repo, agent: 'shell' as any, name: 'plain' });
    await new Promise((r) => setTimeout(r, 300));
    await h.runtime.prompt(pane2.id, 'how does computeTotalPrice work?', true, false, 5000);
    const plain = { text: await until(pane2.id, /how does computeTotalPrice work\?/) };
    assert.doesNotMatch(plain.text, /Graph, for this prompt/, 'off switch honoured');
  } finally { await h.close(); }
  // Windows: the in-process graph engine keeps graph.db open until exit; the isolated test temp root is removed later.
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); } catch (e) { if (process.platform !== 'win32') throw e; }
});
