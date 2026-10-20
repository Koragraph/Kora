// Fixer round 3 (live QA #3): research honesty and reply style in the prompt, Kora reading and attaching a teammate's
// outputs, spreadsheet number formats, listener hygiene, duplicate template routines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness, tempHome } from './routines/testkit';
tempHome('blobs-f3-');

import { blobSystemPromptText, sourcesRules, replyStyleRules, behaviourRules, workspaceSection } from './prompt';
import { resolveAttachment, selfToolSpecs, teamReadDirs } from './tools';
import { blobPolicy, type BlobPolicyContext } from '../session/blob-policy';
import { STARTERS } from './templates';
import { DOC_SKILLS } from './skills/docs-pack';
import { runDocTool } from './doctools';
import { applyAutoFormats, currencySymbol, inferNumberFormat } from './doctools/xlsx';
import { isSupersededSuggestion } from './routines/service';
import type { BlobProfile } from './types';

const input = (blob: BlobProfile, over: Record<string, unknown> = {}) => ({
  blob, soul: '', aboutMe: '', core: { you: '', blob: '' }, agent: 'claude', blobHome: '/h', skillIndex: '', koraCmd: 'kora', canDelegateLegwork: false, ...over,
}) as Parameters<typeof blobSystemPromptText>[0];

// ── prompt text ────────────────────────────────────────────────────────────────────────────────────────────────
test('every blob prompt makes real links mandatory when asked, and cites or hedges checkable claims (wins over the SOUL)', () => {
  const h = harness();
  const popo = h.store.get(h.popo.id)!;
  const text = blobSystemPromptText(input(popo, { soul: h.store.soul(popo.id) }));
  const rules = sourcesRules().join('\n');
  assert.ok(text.includes(rules), 'the sources rules are in the system prompt');
  assert.match(rules, /links, sources, articles or references, EVERY item in your reply carries its real URL/);
  assert.match(rules, /in the chat message itself/);
  assert.match(rules, /never guess or rebuild one/);
  assert.match(rules, /tax credit/);
  assert.match(rules, /carries its source link, or is plainly hedged/);
  assert.match(rules, /win over your SOUL/);
  // Popo's own SOUL says the same in her voice
  assert.match(h.store.soul(popo.id), /a name without a URL is not an answer/);
  assert.match(h.store.soul(popo.id), /I could not confirm this/);
  // codex / opencode prompts carry it as well
  assert.ok(blobSystemPromptText(input(popo, { agent: 'codex' })).includes(rules));
});

test('replies point at the card instead of repeating file names, and never tell the user to approve what a card already shows', () => {
  const h = harness();
  const text = blobSystemPromptText(input(h.store.get(h.junip.id)!));
  const rules = replyStyleRules().join('\n');
  assert.ok(text.includes(rules));
  assert.match(rules, /Do not repeat its file name or path/);
  assert.match(rules, /the spreadsheet below/);
  assert.match(rules, /Never tell the user to "approve it"/);
  assert.match(workspaceSection(h.store.get(h.junip.id)!, 'claude').join('\n'), /the chat shows it as a card/);
  assert.doesNotMatch(workspaceSection(h.store.get(h.junip.id)!, 'codex').join('\n'), /always mention the absolute path/);
  assert.ok(behaviourRules().join('\n').includes(rules));
});

test('no starter SOUL or document skill tells a blob to put the absolute path in its reply', () => {
  for (const s of STARTERS) assert.doesNotMatch(s.soul, /absolute path in your reply|include the absolute path/i, `${s.id} soul`);
  for (const d of DOC_SKILLS) assert.doesNotMatch(d.body, /give the user the absolute path|give the absolute path/i, `${d.name} skill`);
});

test('the Chief is told her teammates\' files are readable and that a finished job still needs her one combined answer', () => {
  const h = harness();
  const kora = h.store.get(h.kora.id)!;
  const text = blobSystemPromptText(input(kora, { teamCards: 'TEAM' }));
  assert.match(text, /teammates' finished files are readable by you \(read-only\)/);
  assert.match(text, /attach_output with that path/);
  assert.match(text, /ONE combined answer/);
});

test('attach_output\'s answer tells the model not to repeat the file name', async () => {
  const h = harness();
  const popo = h.store.get(h.popo.id)!;
  fs.mkdirSync(path.join(popo.workspace, 'outputs'), { recursive: true });
  fs.writeFileSync(path.join(popo.workspace, 'outputs', 'brief.md'), '# hi');
  const attached: string[] = [];
  const specs = selfToolSpecs({ store: h.store, memory: {} as never }, { blobId: popo.id, threadId: 't', agent: 'claude', cwd: popo.workspace, attachOutput: (p) => { attached.push(p); } });
  const r = await specs.find((s) => s.name === 'attach_output')!.handler({ path: path.join(popo.workspace, 'outputs', 'brief.md') });
  assert.equal(r.isError, undefined);
  assert.match(r.text, /shows as a card under your reply/);
  assert.match(r.text, /do not repeat its file name or path/);
  assert.equal(attached.length, 1);
});

// ── Kora reads and attaches teammates' outputs ──────────────────────────────────────────────────────────────────
test('Kora can attach a teammate\'s output (copied into her outputs/); a member cannot, and nobody can reach outside the team', async () => {
  const h = harness();
  const kora = h.store.get(h.kora.id)!, popo = h.store.get(h.popo.id)!, junip = h.store.get(h.junip.id)!;
  fs.mkdirSync(path.join(popo.workspace, 'outputs'), { recursive: true });
  const theirs = path.join(popo.workspace, 'outputs', 'austin-plan.md');
  fs.writeFileSync(theirs, '# Austin');
  // Kora: allowed, and the card points inside HER folder
  const mine = resolveAttachment(kora.workspace, theirs, { readFrom: teamReadDirs(h.store, kora.id) });
  assert.ok('path' in mine, JSON.stringify(mine));
  assert.ok(mine.path.startsWith(fs.realpathSync(kora.workspace) + path.sep));
  assert.equal(path.basename(mine.path), 'austin-plan.md');
  assert.equal(fs.readFileSync(mine.path, 'utf8'), '# Austin');
  assert.ok(fs.existsSync(theirs), 'the teammate\'s file is untouched');
  // a member gets no read dirs: the old refusal stands
  assert.deepEqual(teamReadDirs(h.store, junip.id), []);
  const refused = resolveAttachment(junip.workspace, theirs, { readFrom: teamReadDirs(h.store, junip.id) });
  assert.ok('error' in refused && /outside your folder/.test(refused.error));
  // outside the team entirely: refused for Kora as well
  const stray = path.join(path.dirname(kora.workspace), 'stray.md');
  fs.writeFileSync(stray, 'x');
  assert.ok('error' in resolveAttachment(kora.workspace, stray, { readFrom: teamReadDirs(h.store, kora.id) }));
  assert.ok('error' in resolveAttachment(kora.workspace, '/etc/hosts', { readFrom: teamReadDirs(h.store, kora.id) }));
  // the tool itself passes the team dirs for the Chief only
  const attached: string[] = [];
  const korasTools = selfToolSpecs({ store: h.store, memory: {} as never }, { blobId: kora.id, threadId: 't', agent: 'claude', cwd: kora.workspace, attachOutput: (p) => { attached.push(p); } });
  const ok = await korasTools.find((s) => s.name === 'attach_output')!.handler({ path: theirs, caption: 'Plan' });
  assert.equal(ok.isError, undefined, ok.text);
  assert.equal(attached.length, 1);
  const junipsTools = selfToolSpecs({ store: h.store, memory: {} as never }, { blobId: junip.id, threadId: 't', agent: 'claude', cwd: junip.workspace });
  assert.equal((await junipsTools.find((s) => s.name === 'attach_output')!.handler({ path: theirs })).isError, true);
});

test('the policy lets Kora READ a teammate\'s folder but still asks to write there or to read elsewhere', () => {
  const h = harness();
  // a path outside the temp dir (the policy treats tmp as in bounds, and the test isolate points HOME there); nothing is created
  const home = '/opt/blobs-f3-fixture';
  const koraWs = path.join(home, 'Kora'), popoWs = path.join(home, 'Popo');
  assert.deepEqual(teamReadDirs(h.store, h.kora.id).sort(), [h.popo, h.junip, h.tibbo].map((b) => h.store.get(b.id)!.workspace).sort());
  const ctx: BlobPolicyContext = { workspace: koraWs, blobHome: path.join(home, 'home'), readDirs: () => [popoWs] };
  const file = path.join(popoWs, 'outputs', 'plan.md');
  for (const tool of ['Read', 'Glob', 'Grep', 'LS']) assert.equal(blobPolicy(tool, { file_path: file, path: file }, ctx).decision, 'allow', tool);
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.equal(blobPolicy(tool, { file_path: file }, ctx).decision, 'ask', tool);
  assert.equal(blobPolicy('Read', { file_path: '/etc/hosts' }, ctx).decision, 'ask');
  assert.equal(blobPolicy('Read', { file_path: path.join(home, 'Someone-else', 'x.md') }, ctx).decision, 'ask');
  assert.equal(blobPolicy('Read', { file_path: path.join(popoWs, '..', 'Someone-else', 'x.md') }, ctx).decision, 'ask', '.. does not escape the read dir');
  // a blob with no read dirs keeps the old rule
  assert.equal(blobPolicy('Read', { file_path: file }, { workspace: koraWs, blobHome: path.join(home, 'home') }).decision, 'ask');
});

// ── spreadsheet number formats ──────────────────────────────────────────────────────────────────────────────────
test('number format inference: currency from the header, separators for big numbers, nothing for years / ids / counts', () => {
  assert.equal(inferNumberFormat('Amount (USD)', [2000, 600, 150, 200]), '$#,##0');
  assert.equal(inferNumberFormat('Price ($)', [2.5, 10]), '$#,##0.00');
  assert.equal(inferNumberFormat('Total EUR', [1200.5]), '"€"#,##0.00');
  assert.equal(inferNumberFormat('Cost (GBP)', [10, 20]), '"£"#,##0');
  assert.equal(inferNumberFormat('Monthly (USD)', [2000]), '$#,##0');
  assert.equal(inferNumberFormat('Rent', [2000]), '#,##0', 'money word, no currency named: separators only');
  assert.equal(inferNumberFormat('Savings', [200.5, 60]), '#,##0.00');
  assert.equal(inferNumberFormat('Population', [1200000]), '#,##0');
  assert.equal(inferNumberFormat('Qty', [4, 2]), null);
  assert.equal(inferNumberFormat('Year', [2024, 2025]), null);
  assert.equal(inferNumberFormat('Order id', [12345]), null);
  assert.equal(inferNumberFormat('Zip code', [75001]), null);
  assert.equal(inferNumberFormat('Growth %', [0.12]), null);
  assert.equal(inferNumberFormat('Items', [1999, 2001]), null, 'a column of year-like integers is left alone');
  assert.equal(inferNumberFormat('Amount (USD)', []), null);
  assert.equal(currencySymbol('Price (USD)'), '$');
  assert.equal(currencySymbol('Name'), null);
});

test('xlsx write gives a USD column currency format and its totals row the same; an explicit format always wins', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.KORA_HOME!, 'x-'));
  const f = path.join(dir, 'budget.xlsx');
  const w = await runDocTool('xlsx', 'write', { path: f, sheets: [{ name: 'Budget', columns: [{ header: 'Category' }, { header: 'Monthly (USD)' }, { header: 'Items' }, { header: 'Bonus (USD)', format: '0.0' }], rows: [['Rent', 2000, 3, 5], ['Food', 600, 4, 6]], totals: { label: 'Total', columns: ['B', 'C', 'D'] } }] });
  assert.equal(w.ok, true, JSON.stringify(w));
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(f);
  const ws = wb.getWorksheet('Budget');
  for (const r of [2, 3, 4]) assert.equal(ws.getCell(r, 2).numFmt, '$#,##0', `B${r}`);
  assert.ok(!ws.getCell(2, 3).numFmt || ws.getCell(2, 3).numFmt === 'General', 'a plain count stays plain');
  for (const r of [2, 3, 4]) assert.equal(ws.getCell(r, 4).numFmt, '0.0', 'a format the model chose is kept');
  assert.equal(ws.getCell(4, 2).value.result, 2600);
});

test('xlsx edit: a column computed from a formatted one copies its format; untouched columns of the user\'s file keep their look', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.KORA_HOME!, 'x-'));
  const f = path.join(dir, 'b.xlsx');
  await runDocTool('xlsx', 'write', { path: f, sheets: [{ name: 'S', columns: [{ header: 'Category' }, { header: 'Monthly (USD)' }, { header: 'Plain amount' }], rows: [['Rent', 2000, 1500], ['Food', 600, 1200]] }] });
  // the user's own file: a "Plain amount" column that was written with no format
  const ExcelJS = require('exceljs');
  const pre = new ExcelJS.Workbook(); await pre.xlsx.readFile(f);
  pre.getWorksheet('S').getColumn(3).eachCell((c: any, n: number) => { if (n > 1) c.numFmt = 'General'; });
  await pre.xlsx.writeFile(f);
  const e = await runDocTool('xlsx', 'edit', { path: f, ops: [{ op: 'addColumn', sheet: 'S', header: 'Savings 10% (USD)', formula: '=B{row}*0.1' }, { op: 'addTotals', sheet: 'S', columns: ['B'], label: 'Total' }] });
  assert.equal(e.ok, true, JSON.stringify(e));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(f);
  const ws = wb.getWorksheet('S');
  assert.equal(ws.getCell(2, 4).numFmt, '$#,##0', 'savings copies the $ column\'s format');
  assert.equal(ws.getCell(3, 4).numFmt, '$#,##0');
  assert.equal(ws.getCell(4, 2).numFmt, '$#,##0', 'the totals row too');
  assert.ok(!ws.getCell(2, 3).numFmt || ws.getCell(2, 3).numFmt === 'General', 'an untouched column is not reformatted by an edit elsewhere');
  const sheet = wb.addWorksheet('Z'); sheet.addRow(['Salary', 'N']); sheet.addRow([5000, 1]);
  assert.equal(applyAutoFormats(sheet), 1);
  assert.equal(sheet.getCell(2, 1).numFmt, '#,##0');
});

test('the spreadsheet skill tells the model about formats', () => {
  const sk = DOC_SKILLS.find((s) => s.name === 'kora-spreadsheets')!;
  assert.match(sk.body, /Number formats/);
  assert.match(sk.body, /number_format/);
});

// ── duplicate template routines ─────────────────────────────────────────────────────────────────────────────────
test('creating "Morning brief" replaces Tibbo\'s suggested one: one row, not two', () => {
  const h = harness();
  const before = h.svc.list(h.tibbo.id);
  const template = before.find((r) => r.createdBy === 'template');
  assert.ok(template, 'Tibbo ships a suggested routine');
  const created = h.svc.create({ blobId: h.tibbo.id, title: template!.title, prompt: 'Brief me.', cadence: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '08:00', tz: 'America/Chicago' } });
  assert.equal(created.ok, true);
  const after = h.svc.list(h.tibbo.id);
  assert.equal(after.filter((r) => r.title.toLowerCase() === template!.title.toLowerCase()).length, 1);
  assert.equal(after.find((r) => r.title === template!.title)!.createdBy, 'user');
  // a differently named routine leaves the suggestion alone
  const h2 = harness();
  h2.svc.create({ blobId: h2.tibbo.id, title: 'Evening wrap', prompt: 'Wrap up.', cadence: { kind: 'weekly', days: [1], time: '18:00', tz: 'America/Chicago' } });
  assert.ok(h2.svc.list(h2.tibbo.id).some((r) => r.createdBy === 'template'));
});

test('an older duplicate is hidden from the list, not deleted, and a template that was turned on stays', () => {
  const h = harness();
  const all = h.svc.list(h.tibbo.id);
  const template = all.find((r) => r.createdBy === 'template')!;
  const mine = { ...template, id: 'rt_mine', createdBy: 'user' as const, paused: false };
  assert.equal(isSupersededSuggestion(template, [template, mine]), true);
  assert.equal(isSupersededSuggestion({ ...template, paused: false }, [template, mine]), false, 'a turned-on template is a real routine');
  assert.equal(isSupersededSuggestion(mine, [template, mine]), false);
  assert.equal(isSupersededSuggestion(template, [template]), false);
});

// ── listener hygiene ────────────────────────────────────────────────────────────────────────────────────────────
test('the blob runtime frees every BlobStore listener when it closes, and its own are few', async () => {
  const { BlobStore } = await import('./store');
  const { BlobRuntimeImpl } = await import('./runtime');
  const { inlineMemoryHost } = await import('./memory-host');
  const { openMemory } = await import('../memory');
  const store = new BlobStore();
  const mem = openMemory({ dbPath: ':memory:', extractor: () => Promise.reject(new Error('none')) });
  const rt = new BlobRuntimeImpl({ store, memory: inlineMemoryHost(mem, () => {}), oneShot: async () => null, koraCmd: 'kora', userSkillDirs: [] });
  const changed = store.listenerCount('changed'), aboutMe = store.listenerCount('aboutMe');
  assert.ok(changed + aboutMe <= 8, `the runtime itself should hold only a handful of store listeners (has ${changed + aboutMe})`);
  assert.ok(changed > 0 && aboutMe > 0);
  await rt.close();
  assert.equal(store.listenerCount('changed'), 0, 'changed listeners released');
  assert.equal(store.listenerCount('aboutMe'), 0, 'aboutMe listener released');
});

test('the live browser source is one object per runtime (the shared engine install is keyed on it)', async () => {
  const { BlobStore } = await import('./store');
  const { BlobRuntimeImpl } = await import('./runtime');
  const { inlineMemoryHost } = await import('./memory-host');
  const { openMemory } = await import('../memory');
  const mem = openMemory({ dbPath: ':memory:', extractor: () => Promise.reject(new Error('none')) });
  const rt = new BlobRuntimeImpl({ store: new BlobStore(), memory: inlineMemoryHost(mem, () => {}), oneShot: async () => null, koraCmd: 'kora', userSkillDirs: [] });
  assert.equal(rt.browserLive, rt.browserLive);
  await rt.close();
});

test('KORA_BROWSER_TEST_SOURCE: only a loopback http source with a full description is honoured', async () => {
  const { testEngineSource } = await import('./browser/engine');
  const good = { version: '1.0.0.1', url: 'http://127.0.0.1:4555/engine.zip', sha256: 'a'.repeat(64), size: 10, dirName: 'chrome-headless-shell-fake', binRel: 'chrome-headless-shell' };
  assert.equal(testEngineSource(JSON.stringify(good))!.build.url, good.url);
  assert.equal(testEngineSource(undefined), null);
  assert.equal(testEngineSource('not json'), null);
  for (const bad of [{ url: 'https://evil.example/engine.zip' }, { url: 'http://localhost:1/e.zip' }, { url: 'http://127.0.0.1.evil.example:1/e.zip' }, { sha256: 'short' }, { size: 0 }, { version: 'x' }, { dirName: '../x' }, { binRel: '/bin/sh' }]) {
    assert.equal(testEngineSource(JSON.stringify({ ...good, ...bad })), null, JSON.stringify(bad));
  }
});
