// Round trips of every `kora blob-tools` verb (tiny files, real libraries, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDocTool } from './doctools';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blobtools-'));
const p = (n: string) => path.join(dir, n);

/** A one-page PDF with a text layer, byte offsets computed so the xref is valid. */
function tinyPdf(text: string): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${`BT /F1 18 Tf 20 80 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 18 Tf 20 80 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n'; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('xlsx: write with formulas + totals, read back, edit (add column, set cell), refuse to clobber', async () => {
  const f = p('budget.xlsx');
  const w = await runDocTool('xlsx', 'write', { path: f, sheets: [{ name: 'Budget', columns: [{ header: 'Item' }, { header: 'Qty' }, { header: 'Price', format: '$#,##0.00' }], rows: [['Pens', 4, 2.5], ['Paper', 2, 10]], totals: { label: 'Total', columns: ['B', 'C'] } }] });
  assert.equal(w.ok, true, JSON.stringify(w));
  const r = (await runDocTool('xlsx', 'read', { path: f })) as any;
  assert.deepEqual(r.sheets[0].rows[0], ['Item', 'Qty', 'Price']);
  assert.deepEqual(r.sheets[0].rows[3], ['Total', 6, 12.5]);
  assert.equal(r.sheets[0].formulas.B4, '=SUM(B2:B3)');
  const e = await runDocTool('xlsx', 'edit', { path: f, ops: [{ op: 'addColumn', sheet: 'Budget', header: 'Cost', formula: '=B{row}*C{row}', format: '$#,##0.00' }, { op: 'setCell', sheet: 'Budget', cell: 'A2', value: 'Gel pens' }] });
  assert.equal(e.ok, true, JSON.stringify(e));
  const r2 = (await runDocTool('xlsx', 'read', { path: f, range: 'A1:D3' })) as any;
  assert.equal(r2.sheets[0].rows[1][0], 'Gel pens');
  assert.equal(r2.sheets[0].formulas.D2, '=B2*C2');
  const again = await runDocTool('xlsx', 'write', { path: f, sheets: [{ name: 'X', rows: [[1]] }] });
  assert.equal(again.ok, false);
  assert.match(String(again.error), /overwrite/);
  const series = (await runDocTool('xlsx', 'read', { path: f, series: { category: 'A2:A3', values: 'B2:B3' } })) as any;
  assert.deepEqual(series.series, { categories: ['Gel pens', 'Paper'], values: [4, 2] });
});

test('docx: write headings/lists/table, read back, edit by replacement + append', async () => {
  const f = p('memo.docx');
  const w = await runDocTool('docx', 'write', { path: f, title: 'Trip memo', blocks: [{ type: 'heading', level: 1, text: 'Plan' }, { type: 'paragraph', text: 'We leave on Friday.' }, { type: 'bullets', items: ['Book hotel', 'Pack'] }, { type: 'numbered', items: ['One', 'Two'] }, { type: 'table', header: ['Day', 'City'], rows: [['Fri', 'Lisbon']] }] });
  assert.equal(w.ok, true, JSON.stringify(w));
  const r = (await runDocTool('docx', 'read', { path: f })) as any;
  assert.match(r.text, /We leave on Friday/);
  assert.ok(r.paragraphs.some((x: any) => /Heading1/.test(x.style) && x.text === 'Plan'));
  assert.deepEqual(r.tables[0], [['Day', 'City'], ['Fri', 'Lisbon']]);
  const e = (await runDocTool('docx', 'edit', { path: f, replacements: [{ find: 'Friday', replace: 'Saturday' }], appendParagraphs: ['Added later.'] })) as any;
  assert.equal(e.replacements.Friday, 1);
  const r2 = (await runDocTool('docx', 'read', { path: f })) as any;
  assert.match(r2.text, /Saturday/);
  assert.match(r2.text, /Added later/);
});

test('pptx: write a deck with bullets, table and chart, read the text back', async () => {
  const f = p('deck.pptx');
  const w = await runDocTool('pptx', 'write', { path: f, title: 'Q3', slides: [{ title: 'Q3 review', subtitle: 'Team update' }, { title: 'Highlights', bullets: ['Revenue up', 'Churn down'], notes: 'say it slowly' }, { title: 'Numbers', chart: { type: 'bar', labels: ['Jul', 'Aug'], series: [{ name: 'Rev', values: [3, 5] }] } }, { title: 'Table', table: { header: ['a', 'b'], rows: [['1', '2']] } }] });
  assert.equal(w.ok, true, JSON.stringify(w));
  const r = (await runDocTool('pptx', 'read', { path: f })) as any;
  assert.equal(r.slides.length, 4);
  assert.deepEqual(r.slides[1].texts, ['Highlights', 'Revenue up', 'Churn down']);
  assert.equal(r.slides[1].notes.includes('say it slowly'), true);
});

test('pdf: read the text layer, page selection, info; a non-pdf is a clean error', async () => {
  const f = p('hello.pdf');
  fs.writeFileSync(f, tinyPdf('Hello from a blob'));
  const r = (await runDocTool('pdf', 'read', { path: f, pages: '1' })) as any;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.pages[0].text, /Hello from a blob/);
  assert.equal(r.totalPages, 1);
  assert.equal(((await runDocTool('pdf', 'info', { path: f })) as any).totalPages, 1);
  fs.writeFileSync(p('x.pdf'), 'not a pdf');
  assert.equal((await runDocTool('pdf', 'read', { path: p('x.pdf') })).ok, false);
});

test('bad calls never throw: unknown tool/verb, missing path, missing file', async () => {
  assert.equal((await runDocTool('nope', 'read', {})).ok, false);
  assert.equal((await runDocTool('xlsx', 'nope', {})).ok, false);
  assert.match(String((await runDocTool('xlsx', 'read', {})).error), /path/);
  assert.equal((await runDocTool('xlsx', 'read', { path: p('missing.xlsx') })).ok, false);
});
