// The formula evaluator behind cached values (copied byte-for-byte into apps/web/.../previews/formula.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, FormulaError, type Ref, type Val } from './doctools/formula';

const grid: Record<string, Val> = { A1: 10, A2: 20, A3: 30, B1: 2, B2: 'x', B3: null, C1: 0.5 };
const key = (r: Ref) => `${String.fromCharCode(64 + r.col)}${r.row}`;
const sheets: Record<string, Record<string, Val>> = { 'My Sheet': { A1: 100 }, Other: { A1: 7 } };
const res = { cell: (r: Ref): Val => { if (r.sheet) return sheets[r.sheet]?.[key(r)] ?? null; const v = grid[key(r)]; if (v === 'ERR') throw new FormulaError('#DIV/0!'); return v ?? null; } };
const v = (f: string) => { const r = evaluate(f, res); return r.ok ? r.value : r.error; };

test('arithmetic, precedence, percent, unary minus', () => {
  assert.equal(v('=1+2*3'), 7);
  assert.equal(v('=(1+2)*3'), 9);
  assert.equal(v('=2^3^2'), 64);   // left-assoc like Excel: (2^3)^2
  assert.equal(v('=-2^2'), 4);     // Excel: unary minus first
  assert.equal(v('=50%'), 0.5);
  assert.equal(v('=A1*C1'), 5);
  assert.equal(v('=A1/B1+1'), 6);
  assert.equal(v('=10/0'), '#DIV/0!');
  assert.equal(v('=A1+B2'), '#VALUE!');
});

test('SUM / AVERAGE / MIN / MAX / COUNT over ranges skip text and blanks', () => {
  assert.equal(v('=SUM(A1:A3)'), 60);
  assert.equal(v('=SUM(A1:A3, 5)'), 65);
  assert.equal(v('=SUM(B1:B3)'), 2);
  assert.equal(v('=AVERAGE(A1:A3)'), 20);
  assert.equal(v('=MIN(A1:A3)'), 10);
  assert.equal(v('=MAX(A1:A3)'), 30);
  assert.equal(v('=COUNT(B1:B3)'), 1);
  assert.equal(v('=COUNTA(B1:B3)'), 2);
  assert.equal(v('=AVERAGE(B2:B3)'), '#DIV/0!');
  assert.equal(v('=SUM(A1:A3)/COUNT(A1:A3)'), 20);
  assert.equal(v('=SUM($A$1:$A$3)'), 60);
});

test('cross-sheet refs, IF / IFERROR / ROUND / text', () => {
  assert.equal(v("='My Sheet'!A1+Other!A1"), 107);
  assert.equal(v('=SUM(Other!A1:Other!A1)'), 7);
  assert.equal(v('=IF(A1>5,"big","small")'), 'big');
  assert.equal(v('=IF(A1>50,1,0)'), 0);
  assert.equal(v('=IFERROR(A1/0,"n/a")'), 'n/a');
  assert.equal(v('=IFERROR(A1/2,0)'), 5);
  assert.equal(v('=ROUND(2.345,2)'), 2.35);
  assert.equal(v('=ROUND(-2.5,0)'), -3);
  assert.equal(v('="a"&"b"&A1'), 'ab10');
  assert.equal(v('=A1=10'), true);
  assert.equal(v('=AND(A1>1,A2>1)'), true);
});

test('unknown functions and garbage report an error instead of a number', () => {
  assert.equal(v('=VLOOKUP(A1,A1:B2,2,0)'), '#NAME?');
  assert.equal(v('=SUM('), '#NAME?');
  assert.equal(v('=A1 A2'), '#NAME?');
});
