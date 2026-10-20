// Live QA 2026-10-09: a spreadsheet a blob built showed 0 for every formula (openpyxl stores no cached value). The tool now
// writes a result with every formula and fills in missing ones on read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDocTool } from './doctools';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blobtools-f-'));
const p = (n: string) => path.join(dir, n);

test('xlsx write: every formula carries a cached result (cells, totals, percentages, cross-sheet refs)', async () => {
  const f = p('sales.xlsx');
  await runDocTool('xlsx', 'write', { path: f, sheets: [
    { name: 'Data', columns: [{ header: 'Item' }, { header: 'Qty' }, { header: 'Price' }, { header: 'Total' }], rows: [['A', 2, 10, '=B2*C2'], ['B', 3, 5, '=B3*C3']], totals: { label: 'Sum', columns: ['B', 'D'] }, cells: { F1: '=AVERAGE(C2:C3)', F2: '=D4/2', F3: '=ROUND(D4*10%,1)', G1: '=IF(D4>30,"big","small")' } },
    { name: 'Summary', rows: [['Grand', "=Data!D4+1"]] },
  ] });
  const r = (await runDocTool('xlsx', 'read', { path: f })) as any;
  const data = r.sheets[0].rows;
  assert.equal(data[1][3], 20);
  assert.equal(data[2][3], 15);
  assert.equal(data[3][3], 35, 'SUM total');
  assert.equal(data[0][5], 7.5);
  assert.equal(data[1][5], 17.5);
  assert.equal(data[2][5], 3.5);
  assert.equal(data[0][6], 'big');
  assert.equal(r.sheets[1].rows[0][1], 36, 'cross-sheet reference');
  assert.equal(r.sheets[0].formulas.D2, '=B2*C2');
});

test('xlsx read: a workbook with formulas and NO cached values (what openpyxl writes) reads as real numbers', async () => {
  const f = p('openpyxl-like.xlsx');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['Month', 'Revenue', 'Cost', 'Profit']);
  ws.addRow(['Jan', 1000, 400, { formula: 'B2-C2' }]);
  ws.addRow(['Feb', 1500, 600, { formula: 'B3-C3' }]);
  ws.addRow(['Total', { formula: 'SUM(B2:B3)' }, { formula: 'SUM(C2:C3)' }, { formula: 'SUM(D2:D3)' }]); // depends on formulas
  ws.getCell('F1').value = { formula: 'D4/B4' }; // a ratio
  await wb.xlsx.writeFile(f);
  const raw = new ExcelJS.Workbook(); await raw.xlsx.readFile(f);
  assert.equal((raw.getWorksheet('Sheet1').getCell('D2').value as any).result, undefined, 'the fixture really has no cached value');
  const r = (await runDocTool('xlsx', 'read', { path: f })) as any;
  assert.deepEqual(r.sheets[0].rows[1], ['Jan', 1000, 400, 600, null, null]);
  assert.deepEqual(r.sheets[0].rows[3].slice(0, 4), ['Total', 2500, 1000, 1500]);
  assert.ok(Math.abs(r.sheets[0].rows[0][5] - 0.6) < 1e-9);
  assert.equal(r.sheets[0].formulas.D4, '=SUM(D2:D3)');
});

test('xlsx edit: editing a cell refreshes the cached results of everything that depends on it', async () => {
  const f = p('edit.xlsx');
  await runDocTool('xlsx', 'write', { path: f, sheets: [{ name: 'S', columns: [{ header: 'Qty' }, { header: 'Price' }, { header: 'Cost' }], rows: [[2, 10, '=A2*B2']], totals: { columns: ['C'] } }] });
  await runDocTool('xlsx', 'edit', { path: f, ops: [{ op: 'setCell', sheet: 'S', cell: 'A2', value: 5 }, { op: 'addColumn', sheet: 'S', header: 'Savings', formula: '=C{row}*20%' }] });
  const r = (await runDocTool('xlsx', 'read', { path: f })) as any;
  assert.equal(r.sheets[0].rows[1][2], 50);
  assert.equal(r.sheets[0].rows[2][2], 50, 'the SUM total followed the edit');
  assert.equal(r.sheets[0].rows[1][3], 10);
});

test('xlsx read: an unsupported function keeps the stored result; a circular reference does not hang', async () => {
  const f = p('weird.xlsx');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  ws.getCell('A1').value = { formula: 'VLOOKUP(2,B1:C2,2,0)', result: 99 };
  ws.getCell('A2').value = { formula: 'B2+1' };
  ws.getCell('B2').value = { formula: 'A2+1' };
  await wb.xlsx.writeFile(f);
  const r = (await runDocTool('xlsx', 'read', { path: f })) as any;
  assert.equal(r.sheets[0].rows[0][0], 99);
  assert.equal(r.sheets[0].rows[1][0], null);
});
