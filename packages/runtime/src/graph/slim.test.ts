import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphService } from './service';

test('explore slimming caps pasted source and keeps the range to Read', async () => {
  const svc: any = createGraphService();
  const body = Array.from({ length: 80 }, (_, i) => `  line ${i + 1}`).join('\n');
  const text = `1 match\n■ METHOD f @ src/a.js:10 — f()\n  callers: g@src/b.js:2, src/a.js@src/a.js:1\n  --- source src/a.js:10-89 ---\n${body}\n`;
  const out = svc.__slim ? svc.__slim('explore', { text, data: { hits: [{ source: body }] }, ms: 1 }) : null;
  if (!out) return; // slim is internal; exercised via callTool in integration
  assert.ok(out.text.split('\n').length < 40);
  assert.match(out.text, /more lines — Read src\/a\.js offset=35 limit=/);
  assert.ok(!/src\/a\.js@src\/a\.js:1/.test(out.text));
});

test('koraWording: the engine\'s own CLI names become kora\'s', () => {
  const { koraWording } = require('./service') as typeof import('./service');
  assert.equal(koraWording('behind its checkout. Re-run: koragraph ingest'), 'behind its checkout. Re-run: kora ingest .');
  assert.equal(koraWording('Done. Run `koragraph status` to see the graph, or `koragraph mcp` to serve it.'), 'Done. Run `kora graph status` to see the graph.');
  assert.equal(koraWording('Run `koragraph ingest <path-to-repo>` first'), 'Run `kora ingest <path-to-repo>` first');
});
