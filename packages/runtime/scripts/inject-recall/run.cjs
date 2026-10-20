// Injection-recall replay: runs the REAL injectForPrompt (dist) over fixtures.json against a tiny indexed scratch repo and
// prints the injection rate and precision. Usage: KORA_HOME=<scratch> node scripts/inject-recall/run.cjs <repo> [--json]
// Needs `pnpm --filter @kora/runtime build` (dist) and the repo indexed once with `kora ingest <repo>` under the same KORA_HOME.
const path = require('node:path');
const fs = require('node:fs');
const repo = path.resolve(process.argv[2] || '');
if (!repo || !fs.existsSync(repo)) { console.error('usage: run.cjs <indexed repo>'); process.exit(2); }
process.env.KORA_INJECT_LOG = process.env.KORA_INJECT_LOG || '0';
process.env.KORA_AUTO_INGEST = '0';
const dist = path.join(__dirname, '..', '..', 'dist');
const pi = require(path.join(dist, 'graph', 'prompt-inject.js'));
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
let carry = null; try { carry = require(path.join(dist, 'graph', 'inject-carry.js')); } catch { /* baseline run: module not there yet */ }
(async () => {
  const rows = [];
  for (const s of fx.sessions) {
    const sid = `recall-${s.id}-${process.pid}`;
    for (const t of s.turns) {
      if (carry && t.files && carry.noteEntities) carry.noteEntities(sid, { files: t.files });
      const text = await pi.injectForPrompt({ prompt: t.p, cwd: repo, sessionId: sid, lane: 'desktop-chat' });
      const rec = pi.lastInjectRecord;
      const names = (text || '').split('\n').filter((l) => /^\s*■/.test(l)).map((l) => (/^\s*■\s*[A-Z_]+\s+(\S+)/.exec(l) || [])[1]).filter(Boolean);
      const fileHit = /^File (\S+) /m.exec(text || '');
      const injected = !!text;
      let verdict;
      if (t.expect === '-') verdict = injected ? 'WRONG-INJECT' : 'ok-skip';
      else if (!injected) verdict = 'miss';
      else if (t.expect === '*') verdict = 'ok-inject';
      else verdict = names.some((n) => n === t.expect || n.endsWith('.' + t.expect)) ? 'ok-inject' : 'WRONG-TARGET';
      rows.push({ session: s.id, p: t.p, expect: t.expect, injected, reason: rec && rec.reason, query: rec && rec.query, names: names.slice(0, 3), file: fileHit && fileHit[1], verdict, chars: (text || '').length, ms: rec && rec.ms });
    }
  }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(rows, null, 1)); return; }
  for (const r of rows) console.log(`${r.verdict.padEnd(13)} ${String(r.reason).padEnd(18)} ${String(r.ms).padStart(5)}ms  [${r.session}] ${r.p.slice(0, 60)}  -> ${r.names.join(',') || r.file || ''}`);
  const want = rows.filter((r) => r.expect !== '-'); const none = rows.filter((r) => r.expect === '-');
  const inj = want.filter((r) => r.injected).length;
  console.log(`\nrecall: ${inj}/${want.length} code-ish prompts injected (${Math.round(100 * inj / want.length)}%), correct target ${want.filter((r) => r.verdict === 'ok-inject').length}, wrong target ${want.filter((r) => r.verdict === 'WRONG-TARGET').length}; false injections on chatter/no-context: ${none.filter((r) => r.injected).length}/${none.length}; overall injection rate ${rows.filter((r) => r.injected).length}/${rows.length}`);
})();
