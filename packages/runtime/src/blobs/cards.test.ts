// Capability cards + the delegation log that feeds them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, resetHome, tempHome } from './testkit-team';
tempHome('cards-');

import { BlobStore } from './store';
import { DAY_MS, DelegationLog, normalizeKind } from './delegation';
import { JobStore } from './jobs';
import { CARD_TOKEN_BUDGET, TeamCards, agoLabel, buildCard, cardsHash, estimateTokens, modelLabel, renderCard, statusWord } from './cards';
import { STARTERS, hireTemplate } from './templates';

const row = (log: DelegationLog, blobId: string, kind: string, o: Partial<{ outcome: 'done' | 'failed' | 'cancelled'; ms: number; ts: number; title: string; reaction: 'good' | 'redo' }> = {}) =>
  log.append({ jobId: 'j', stepId: 's', blobId, kind, title: o.title ?? `${kind} task`, brief: 'brief', outcome: o.outcome ?? 'done', durationMs: o.ms ?? 60_000, tokens: 10, ts: o.ts, reaction: o.reaction });

function team() {
  resetHome();
  const store = new BlobStore();
  store.ensureKora(ENGINE, 'I run the team.');
  const popo = (hireTemplate(store, 'popo', { defaultEngine: ENGINE }) as any).profile;
  const wobbo = (hireTemplate(store, 'wobbo', { defaultEngine: ENGINE }) as any).profile;
  const log = new DelegationLog({ file: null });
  const jobs = new JobStore({ dir: null });
  const cards = new TeamCards({ store, log, jobs, skillsOf: () => [] });
  return { store, popo, wobbo, log, jobs, cards };
}

test('a card renders in the SPEC shape and stays inside the token budget', () => {
  const { popo, store } = team();
  const c = buildCard(popo, { soul: store.soul(popo.id), skills: ['web-research', 'citation-check'], stats: { goodAt: ['market-scan', 'travel-research'], slowAt: ['spreadsheets'] }, lately: [{ title: 'EV charger market brief', what: 'done 2d ago' }, { title: 'Lisbon neighbourhoods', what: 'running' }] });
  const text = renderCard(c, 'idle');
  assert.equal(text.split('\n')[0], 'Popo · Researcher · Sonnet · Auto · idle');
  assert.match(text, /^does: deep web research \u2192 sourced brief in outputs\/$/m);
  assert.match(text, /^skills: web-research, citation-check · apps: none · computer: browser$/m);
  assert.match(text, /^lately: "EV charger market brief" \(done 2d ago\), "Lisbon neighbourhoods" \(running\)$/m);
  assert.match(text, /^good at \(from past jobs\): market scan, travel research · slow at: spreadsheets$/m);
  assert.ok(estimateTokens(text) <= CARD_TOKEN_BUDGET, `${estimateTokens(text)} tokens`);
  // worst case: long everything still fits
  const fat = buildCard({ ...popo, toolGrants: { apps: { mode: 'list', allow: ['gmail', 'googlecalendar', 'slack', 'notion'] }, mcp: [], computer: { browser: true, vm: true } } }, {
    does: 'x'.repeat(200), skills: Array.from({ length: 9 }, (_, i) => `a-long-skill-name-${i}`), stats: { goodAt: ['market-scan', 'travel-research'], slowAt: ['spreadsheets', 'invoices'] },
    lately: [1, 2, 3].map((i) => ({ title: 'T'.repeat(80) + i, what: 'done 12d ago' })),
  });
  assert.ok(estimateTokens(renderCard(fat, 'waiting on you')) <= CARD_TOKEN_BUDGET);
  for (const s of STARTERS) assert.ok(estimateTokens(renderCard(buildCard({ ...popo, name: s.name, title: s.title, templateId: s.id }, {}), 'working (2)')) <= CARD_TOKEN_BUDGET, s.name);
  assert.equal(modelLabel('claude-sonnet-5-5'), 'Sonnet'); assert.equal(modelLabel('big-pickle'), 'big-pickle'); assert.equal(modelLabel('gpt-5.1-codex-max-high'), 'gpt-5.1-codex-');
  assert.deepEqual([agoLabel(5_000), agoLabel(5 * 60_000), agoLabel(3 * 3600_000), agoLabel(2 * DAY_MS)], ['just now', '5m ago', '3h ago', '2d ago']);
  assert.equal(statusWord({ running: 0, needsYou: false }), 'idle');
  assert.equal(statusWord({ running: 3, needsYou: false }), 'busy');
  assert.equal(statusWord({ running: 1, needsYou: true }), 'waiting on you');
});

test('custom blobs get a does-line from their SOUL', () => {
  const { store } = team();
  const b = store.create({ name: 'Tiki', title: 'Refund Watcher', soul: '# Tiki\nYou are Tiki, the refund watcher who keeps an eye on Shopify orders. Be calm.', engine: ENGINE });
  assert.match(renderCard(buildCard(b, { soul: store.soul(b.id) })), /does: refund watcher who keeps an eye on Shopify orders\./);
});

test('team cards: archived and the Chief are excluded; rebuilt on store changes', () => {
  const { store, popo, wobbo, cards } = team();
  assert.deepEqual(cards.cards().map((c) => c.name), ['Popo', 'Wobbo']);
  const h0 = cards.hash();
  store.archive(wobbo.id);
  assert.deepEqual(cards.cards().map((c) => c.name), ['Popo']);
  assert.notEqual(cards.hash(), h0);
  store.update(popo.id, { title: 'Senior Researcher' });
  assert.match(cards.render(true), /Popo · Senior Researcher/);
  assert.doesNotMatch(cards.render(true), /Wobbo/);
  assert.match(cards.teamBlock(), /^# Your team/);
});

test('lately and good-at come from the delegation log; a redo removes good-at; running steps show as running', () => {
  const { popo, log, jobs, cards } = team();
  assert.doesNotMatch(cards.render(true), /lately:/);
  row(log, popo.id, 'market-scan', { title: 'EV charger brief', ts: Date.now() - 2 * DAY_MS });
  row(log, popo.id, 'market-scan', { title: 'Heat pump scan' });
  row(log, popo.id, 'travel', { title: 'Lisbon' });
  let t = cards.render(true);
  assert.match(t, /lately: "Lisbon" \(done just now\), "Heat pump scan" \(done just now\), "EV charger brief" \(done 2d ago\)/);
  assert.match(t, /good at \(from past jobs\): market scan/);
  assert.doesNotMatch(t, /good at[^\n]*travel/, 'one travel job is not enough');
  // redo within the window wipes the kind from good-at
  log.react({ jobId: 'j', stepId: 's' }, 'redo');
  const rs = log.rows(); assert.ok(rs.some((r) => r.reaction === 'redo'));
  // the redo applied to the newest row (travel); mark a market-scan row redo too
  log.react({ rowId: rs.find((r) => r.kind === 'market-scan')!.id }, 'redo');
  t = cards.render(true);
  assert.doesNotMatch(t, /good at/);
  // an active step shows first
  jobs.add({ id: 'job1', title: 'x', koraThreadId: null, createdAt: 1, updatedAt: 1, version: 1, cancelled: false, steps: [{ id: 's1', blobId: popo.id, blobName: 'Popo', title: 'Compare chargers', task: 't', kind: 'research', dependsOn: [], output: null, state: 'running', threadId: 'th1', brief: 'b', queuedAt: 1, queuedReason: null, resultGist: null, finalText: null, outputs: [], startedAt: 1, finishedAt: null, checkingSince: null, attempts: 1, redo: false, tokens: 0, error: null }] });
  assert.match(cards.render(true), /lately: "Compare chargers" \(running\), "Lisbon"/);
  assert.match(cards.render(true), /Popo · Researcher · Sonnet · Auto · working \(1\)/);
});

test('good-at needs 2 done within 90 days; slow-at compares against the rest of the team; status is not in the hash', () => {
  const { popo, wobbo, log, cards } = team();
  row(log, popo.id, 'research', { ts: Date.now() - 120 * DAY_MS }); row(log, popo.id, 'research', { ts: Date.now() - 100 * DAY_MS });
  assert.deepEqual(log.stats(popo.id).goodAt, [], 'older than 90 days');
  row(log, popo.id, 'research'); row(log, popo.id, 'research');
  assert.deepEqual(log.stats(popo.id).goodAt, ['research']);
  for (let i = 0; i < 3; i++) { row(log, popo.id, 'analysis', { ms: 600_000 }); row(log, wobbo.id, 'analysis', { ms: 60_000 }); }
  assert.deepEqual(log.stats(popo.id).slowAt, ['analysis']);
  assert.deepEqual(log.stats(wobbo.id).slowAt, []);
  assert.match(cards.render(true), /Popo[^\n]*\n[\s\S]*slow at: analysis/);
  const a = cardsHash(cards.cards());
  assert.equal(cardsHash(cards.cards()), a);
  assert.equal(normalizeKind('Market Scan!'), 'market-scan'); assert.equal(normalizeKind(''), 'general');
});

test('the log survives a reload and keeps reactions', () => {
  const file = require('node:path').join(process.env.KORA_HOME!, 'dlg.jsonl');
  const a = new DelegationLog({ file });
  const r = a.append({ jobId: 'j1', stepId: 's1', blobId: 'b', kind: 'writing', title: 'Memo', brief: 'x', outcome: 'done', durationMs: 5, tokens: 1 });
  a.react({ rowId: r.id }, 'good');
  const b = new DelegationLog({ file });
  assert.equal(b.rows().length, 1); assert.equal(b.rows()[0].reaction, 'good');
});
