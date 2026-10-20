// `kora blob-tools xlsx read|write|edit` - spreadsheets with exceljs (pure JS). JSON in, JSON out.
//
//   read   {path, sheet?, range?, maxRows?, series?:{category:"A2:A9", values:"B2:B9"}}
//   write  {path, overwrite?, sheets:[{name, columns?:[{header, key?, width?, format?}], rows:[[..]|{..}],
//           cells?:{"E2":"=B2*C2"}, header?:{bold,fill,fontColor}, freeze?:bool, autoFilter?:bool,
//           columnFormats?:{"C":"$#,##0.00"}, totals?:{label?, columns:["B","C"], function?:"SUM"}}]}
//   edit   {path, out?, ops:[{op:"setCell",sheet,cell,value} | {op:"addColumn",sheet,header,values?|formula?:"=B{row}*C{row}",format?,width?}
//           | {op:"addRow",sheet,values} | {op:"addSheet",name,rows?} | {op:"deleteSheet",sheet} | {op:"renameSheet",sheet,name}
//           | {op:"formatHeader",sheet,bold?,fill?,fontColor?} | {op:"addTotals",sheet,columns,label?,function?}
//           | {op:"setColumnFormat",sheet,column,format} | {op:"setColumnWidth",sheet,column,width} | {op:"freeze",sheet,row?}
//           | {op:"deleteRow",sheet,row} | {op:"deleteColumn",sheet,column}]}
// A string value starting with "=" is a formula. Every formula this tool writes ALSO gets a cached result (evaluated by
// ./formula.ts: arithmetic, cell refs, ranges, SUM/AVERAGE/MIN/MAX/COUNT/IF/ROUND ...), so previews and `read` show real
// numbers instead of 0/null. `read` fills in a missing cached result for files written elsewhere (openpyxl stores none).
// Excel still recalculates on open (fullCalcOnLoad).
import type { Cell, CellValue, Row, Workbook, Worksheet } from 'exceljs';
import { ToolError, assertWritable, need, resolvePath, type Verb } from './util';
import { evaluate, FormulaError, type Ref, type Val } from './formula';

const ExcelJS = (): typeof import('exceljs') => require('exceljs');

type Json = Record<string, any>;
const colLetter = (n: number): string => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const colIndex = (l: string): number => l.toUpperCase().split('').reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);

function toCellValue(v: unknown): CellValue {
  if (typeof v === 'string' && v.startsWith('=') && v.length > 1) return { formula: v.slice(1) } as CellValue;
  if (v === undefined) return null;
  if (v && typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
  return v as CellValue;
}

/** Plain JSON for a cell: formulas as "=…", dates as ISO strings. */
function fromCell(cell: Cell): { value: unknown; formula: string | null } {
  const v = cell.value as any;
  if (v && typeof v === 'object' && 'formula' in v) return { value: v.result ?? null, formula: `=${v.formula}` };
  if (v && typeof v === 'object' && 'sharedFormula' in v) return { value: v.result ?? null, formula: `=${v.sharedFormula}` };
  if (v instanceof Date) return { value: v.toISOString(), formula: null };
  if (v && typeof v === 'object' && 'richText' in v) return { value: (v.richText as Array<{ text: string }>).map((r) => r.text).join(''), formula: null };
  if (v && typeof v === 'object' && 'text' in v) return { value: String(v.text), formula: null }; // hyperlink
  if (v && typeof v === 'object' && 'error' in v) return { value: String(v.error), formula: null };
  return { value: v ?? null, formula: null };
}

/**
 * Give formula cells a cached `result`. mode 'all' recomputes every formula (after we wrote or edited: dependents of an edited
 * cell must not keep stale numbers); 'missing' only fills cells whose file stored none (openpyxl, a model's script).
 * Formulas the evaluator does not understand keep whatever result they had. Returns how many cells were set.
 */
export function fillFormulaResults(wb: Workbook, mode: 'all' | 'missing'): number {
  const memo = new Map<string, Val | FormulaError>();
  const visiting = new Set<string>();
  const addr = (ws: Worksheet, col: number, row: number) => `${ws.name}!${colLetter(col)}${row}`;
  const valueAt = (ws: Worksheet, col: number, row: number): Val => {
    const k = addr(ws, col, row);
    const cell = ws.getCell(row, col);
    const raw = cell.value as any;
    const isFormula = raw && typeof raw === 'object' && typeof raw.formula === 'string';
    if (!isFormula) {
      const v = fromCell(cell).value;
      return v === undefined ? null : typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : v === null ? null : String(v);
    }
    const hit = memo.get(k);
    if (hit !== undefined) { if (hit instanceof FormulaError) throw hit; return hit; }
    if (visiting.has(k)) throw new FormulaError('#REF!'); // circular
    visiting.add(k);
    try {
      const r = evaluate(raw.formula, {
        cell: (ref: Ref) => {
          const target = ref.sheet ? wb.getWorksheet(ref.sheet) : ws;
          if (!target) throw new FormulaError('#REF!');
          return valueAt(target, ref.col, ref.row);
        },
      });
      if (!r.ok) {
        // the evaluator cannot compute it (an unsupported function): fall back to the stored result, else it is unknown
        if (r.error === '#NAME?' && raw.result !== undefined && raw.result !== null && typeof raw.result !== 'object') { memo.set(k, raw.result as Val); return raw.result as Val; }
        const err = new FormulaError(r.error); memo.set(k, err); throw err;
      }
      memo.set(k, r.value);
      return r.value;
    } finally { visiting.delete(k); }
  };
  let n = 0;
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const raw = cell.value as any;
        if (!raw || typeof raw !== 'object' || typeof raw.formula !== 'string') return;
        const has = raw.result !== undefined && raw.result !== null;
        if (mode === 'missing' && has) return;
        try {
          const v = valueAt(ws, Number(cell.col), Number(cell.row));
          if (v === null) return;
          cell.value = { formula: raw.formula, result: v } as CellValue;
          n++;
        } catch { /* unknown or erroring formula: leave as is */ }
      });
    });
  }
  return n;
}

// ── number formats ──────────────────────────────────────────────────────────────────────────────────────────────
// A column whose header implies money gets a currency (or at least thousands/2-decimal) format; any other number column
// holding values >= 1000 gets thousands separators (live QA #3: a "USD" total rendered as a bare 2950). Only cells with no
// format of their own are touched, so a format the model or user chose always wins.
const CURRENCY: Array<[RegExp, string]> = [
  [/\busd\b|\$|\bus dollars?\b|\bdollars?\b/i, '$'], [/\beur\b|€|\beuros?\b/i, '€'], [/\bgbp\b|£|\bpounds?\b/i, '£'],
  [/\binr\b|₹|\brupees?\b/i, '₹'], [/\bjpy\b|¥|\byen\b/i, '¥'], [/\b(?:cad|aud|nzd|mxn|sgd|hkd)\b/i, '$'],
];
const MONEY_WORD = /\b(price|prices|cost|costs|amount|amounts|budget|salary|salaries|revenue|income|spend|spending|savings?|expenses?|fees?|rent|payments?|balance|profit|wages?|tax|taxes|bills?|pay|paid|owed|debt|loan|sales|subtotal|invoice|charge|charges|deposit|earnings?)\b/i;
/** Columns that hold numbers which are not quantities: never given separators or a currency. */
const NOT_A_QUANTITY = /\b(year|years|id|ids|zip|postal|phone|code|sku|isbn|rank|age|day|month|date|version|no|num|number|#)\b|%|percent|\brate\b/i;

export function currencySymbol(header: string): string | null {
  for (const [re, sym] of CURRENCY) if (re.test(header)) return sym;
  return null;
}

/** The format a numeric column deserves given its header and its values, or null to leave it alone. */
export function inferNumberFormat(header: string, values: readonly number[]): string | null {
  if (!values.length || values.some((v) => !Number.isFinite(v))) return null;
  const h = header.trim();
  if (NOT_A_QUANTITY.test(h) && !currencySymbol(h)) return null;
  const whole = values.every((v) => Number.isInteger(v));
  const dec = whole ? '#,##0' : '#,##0.00';
  const sym = currencySymbol(h);
  if (sym) return `${sym === '$' ? '$' : `"${sym}"`}${dec}`;
  if (MONEY_WORD.test(h)) return whole ? '#,##0' : '#,##0.00';
  // plain quantities: separators only once a value needs them (and not a column of years)
  if (values.every((v) => Number.isInteger(v) && v >= 1800 && v <= 2200)) return null;
  return values.some((v) => Math.abs(v) >= 1000) ? dec : null;
}

const isGeneral = (f: string | undefined): boolean => !f || f === 'General';

/** Apply `inferNumberFormat` to a sheet's columns (all of them, or `only`). Returns how many columns changed. */
export function applyAutoFormats(ws: Worksheet, only?: ReadonlySet<number>): number {
  let changed = 0;
  const last = ws.rowCount;
  for (let c = 1; c <= ws.columnCount; c++) {
    if (only && !only.has(c)) continue;
    const head = fromCell(ws.getCell(1, c)).value;
    if (typeof head !== 'string' || !head.trim()) continue;
    const cells: Cell[] = []; const nums: number[] = [];
    for (let r = 2; r <= last; r++) {
      const cell = ws.getCell(r, c);
      const v = fromCell(cell).value;
      if (typeof v === 'number') { cells.push(cell); nums.push(v); }
    }
    if (!cells.length) continue;
    const fmt = inferNumberFormat(head, nums);
    if (!fmt) continue;
    let any = false;
    for (const cell of cells) if (isGeneral(cell.numFmt)) { cell.numFmt = fmt; any = true; }
    if (any) changed++;
  }
  return changed;
}

function sheetOf(wb: Workbook, name: unknown): Worksheet {
  const ws = typeof name === 'string' && name ? wb.getWorksheet(name) : wb.worksheets[0];
  if (!ws) throw new ToolError(`no sheet ${name ? `"${String(name)}"` : ''} (sheets: ${wb.worksheets.map((s) => s.name).join(', ') || 'none'})`);
  return ws;
}

function applyHeaderStyle(ws: Worksheet, h: Json | undefined): void {
  const row = ws.getRow(1);
  const fill = typeof h?.fill === 'string' ? h.fill.replace('#', '').toUpperCase().padStart(8, 'FF') : 'FFE8E8EC';
  row.eachCell((c) => {
    c.font = { ...(c.font ?? {}), bold: h?.bold !== false, ...(h?.fontColor ? { color: { argb: String(h.fontColor).replace('#', '').toUpperCase().padStart(8, 'FF') } } : {}) };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    c.alignment = { vertical: 'middle', ...(c.alignment ?? {}) };
  });
}

function numericColumn(ws: Worksheet, col: number, firstRow: number, lastRow: number): number[] {
  const out: number[] = [];
  for (let r = firstRow; r <= lastRow; r++) { const v = fromCell(ws.getCell(r, col)).value; if (typeof v === 'number') out.push(v); }
  return out;
}

function addTotals(ws: Worksheet, columns: string[], label: string | undefined, fn = 'SUM'): number {
  const F = fn.toUpperCase();
  if (!['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT'].includes(F)) throw new ToolError(`totals function must be SUM, AVERAGE, MIN, MAX or COUNT, got ${fn}`);
  const last = ws.actualRowCount > 0 ? ws.lastRow!.number : 1;
  const total = last + 1;
  if (label) { const lc = ws.getCell(total, 1); lc.value = label; lc.font = { bold: true }; }
  for (const letter of columns) {
    const ci = colIndex(letter);
    const nums = numericColumn(ws, ci, 2, last);
    const result = F === 'SUM' ? nums.reduce((a, b) => a + b, 0) : F === 'COUNT' ? nums.length : !nums.length ? 0 : F === 'AVERAGE' ? nums.reduce((a, b) => a + b, 0) / nums.length : F === 'MIN' ? Math.min(...nums) : Math.max(...nums);
    const c = ws.getCell(total, ci);
    c.value = { formula: `${F}(${letter.toUpperCase()}2:${letter.toUpperCase()}${last})`, result } as CellValue;
    c.font = { bold: true };
    c.numFmt = ws.getCell(last, ci).numFmt || c.numFmt;
    c.border = { top: { style: 'thin' } };
  }
  return total;
}

function writeRows(ws: Worksheet, rows: unknown[] | undefined, keys: string[] | null): void {
  for (const r of rows ?? []) {
    if (Array.isArray(r)) ws.addRow(r.map(toCellValue));
    else if (r && typeof r === 'object') ws.addRow((keys ?? Object.keys(r)).map((k) => toCellValue((r as Json)[k])));
  }
}

function buildSheet(wb: Workbook, spec: Json): Worksheet {
  const ws = wb.addWorksheet(String(need(spec.name, 'sheet name')).slice(0, 31));
  const cols = Array.isArray(spec.columns) ? (spec.columns as Json[]) : null;
  if (cols) {
    ws.addRow(cols.map((c) => String(c.header ?? c.key ?? '')));
    cols.forEach((c, i) => { const col = ws.getColumn(i + 1); if (c.width) col.width = Number(c.width); if (c.format) col.numFmt = String(c.format); });
  }
  const keys = cols ? cols.map((c) => String(c.key ?? c.header ?? '')) : null;
  const rows = spec.rows as unknown[] | undefined;
  // with no `columns`, a first row of strings is the header when `header` is requested (the default styling)
  writeRows(ws, rows, keys);
  for (const [addr, v] of Object.entries((spec.cells ?? {}) as Json)) ws.getCell(addr).value = toCellValue(v);
  for (const [letter, fmt] of Object.entries((spec.columnFormats ?? {}) as Json)) {
    const col = ws.getColumn(colIndex(letter));
    col.numFmt = String(fmt);
    for (let r = 2; r <= ws.rowCount; r++) ws.getCell(r, colIndex(letter)).numFmt = String(fmt);
  }
  if (spec.header !== false && ws.rowCount > 0) applyHeaderStyle(ws, spec.header as Json | undefined);
  if (spec.totals) addTotals(ws, (spec.totals.columns ?? []) as string[], spec.totals.label, spec.totals.function);
  autoWidth(ws);
  if (spec.freeze !== false && ws.rowCount > 1) ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (spec.autoFilter && ws.columnCount) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  return ws;
}

function autoWidth(ws: Worksheet): void {
  ws.columns.forEach((col, i) => {
    if (col.width) return;
    let max = 8;
    ws.eachRow((row: Row) => { const v = fromCell(row.getCell(i + 1)); const t = String(v.value ?? v.formula ?? ''); if (t.length > max) max = Math.min(t.length, 60); });
    col.width = max + 2;
  });
}

function parseRange(r: string): { r1: number; c1: number; r2: number; c2: number } {
  const m = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(r.trim());
  if (!m) throw new ToolError(`bad range "${r}" (use A1 or A1:D20)`);
  const c1 = colIndex(m[1]), r1 = Number(m[2]);
  return { r1, c1, r2: m[4] ? Number(m[4]) : r1, c2: m[3] ? colIndex(m[3]) : c1 };
}

export const read: Verb = async (input, cwd) => {
  const file = resolvePath(input.path, cwd);
  const wb = new (ExcelJS().Workbook)();
  await wb.xlsx.readFile(file);
  fillFormulaResults(wb, 'missing'); // openpyxl stores no cached value: compute it so nothing reads as 0/null
  const maxRows = Math.min(Number(input.maxRows) || 200, 2000);
  const sheets = input.sheet ? [sheetOf(wb, input.sheet)] : wb.worksheets;
  const out = sheets.map((ws) => {
    const box = input.range ? parseRange(String(input.range)) : { r1: 1, c1: 1, r2: Math.max(ws.rowCount, 1), c2: Math.max(ws.columnCount, 1) };
    const rows: unknown[][] = []; const formulas: Record<string, string> = {};
    for (let r = box.r1; r <= Math.min(box.r2, box.r1 + maxRows - 1); r++) {
      const row: unknown[] = [];
      for (let c = box.c1; c <= box.c2; c++) {
        const cell = fromCell(ws.getCell(r, c));
        row.push(cell.value);
        if (cell.formula) formulas[`${colLetter(c)}${r}`] = cell.formula;
      }
      rows.push(row);
    }
    return { name: ws.name, rowCount: ws.rowCount, columnCount: ws.columnCount, rows, formulas, truncated: box.r2 - box.r1 + 1 > maxRows };
  });
  const res: Record<string, unknown> = { ok: true, path: file, sheets: out };
  if (input.series) {
    const ws = sheetOf(wb, input.sheet);
    const flat = (spec: string) => { const b = parseRange(spec); const v: unknown[] = []; for (let r = b.r1; r <= b.r2; r++) for (let c = b.c1; c <= b.c2; c++) v.push(fromCell(ws.getCell(r, c)).value); return v; };
    res.series = { categories: flat(String(need(input.series.category, 'series.category'))), values: flat(String(need(input.series.values, 'series.values'))) };
  }
  return res;
};

export const write: Verb = async (input, cwd) => {
  const file = resolvePath(input.path, cwd);
  assertWritable(file, input.overwrite);
  const sheets = need(Array.isArray(input.sheets) ? input.sheets : undefined, 'sheets');
  const wb = new (ExcelJS().Workbook)();
  wb.creator = 'Kora blob';
  wb.created = new Date();
  for (const s of sheets) buildSheet(wb, s as Json);
  fillFormulaResults(wb, 'all');
  for (const ws of wb.worksheets) applyAutoFormats(ws);
  wb.calcProperties = { ...(wb.calcProperties ?? {}), fullCalcOnLoad: true };
  await wb.xlsx.writeFile(file);
  return { ok: true, path: file, sheets: wb.worksheets.map((w) => ({ name: w.name, rows: w.rowCount, columns: w.columnCount })) };
};

export const edit: Verb = async (input, cwd) => {
  const file = resolvePath(input.path, cwd);
  const out = input.out ? resolvePath(input.out, cwd) : file;
  const wb = new (ExcelJS().Workbook)();
  await wb.xlsx.readFile(file);
  const ops = need(Array.isArray(input.ops) ? (input.ops as Json[]) : undefined, 'ops');
  const done: string[] = [];
  // Columns this call created or filled: only those get inferred formats (the user's other columns keep their look).
  const touched = new Map<Worksheet, Set<number>>();
  const touch = (ws: Worksheet, c: number) => { const set = touched.get(ws) ?? new Set<number>(); set.add(c); touched.set(ws, set); };
  const fresh = new Set<Worksheet>();
  for (const op of ops) {
    const kind = String(op.op);
    switch (kind) {
      case 'setCell': sheetOf(wb, op.sheet).getCell(String(need(op.cell, 'cell'))).value = toCellValue(op.value); break;
      case 'addRow': { const ws = sheetOf(wb, op.sheet); ws.addRow((need(op.values, 'values') as unknown[]).map(toCellValue)); break; }
      case 'addColumn': {
        const ws = sheetOf(wb, op.sheet);
        const ci = ws.columnCount + 1;
        ws.getCell(1, ci).value = String(need(op.header, 'header'));
        const last = ws.lastRow?.number ?? 1;
        for (let r = 2; r <= last; r++) {
          const v = Array.isArray(op.values) ? op.values[r - 2] : op.formula ? String(op.formula).replace(/\{row\}/g, String(r)) : undefined;
          if (v !== undefined) ws.getCell(r, ci).value = toCellValue(v);
          if (op.format) ws.getCell(r, ci).numFmt = String(op.format);
        }
        touch(ws, ci);
        // a column computed from a formatted one (savings = amount * 10%) looks like it: "$#,##0" stays "$#,##0"
        if (!op.format && op.formula) {
          const refs = [...String(op.formula).matchAll(/\b([A-Z]{1,3})\{row\}/g)].map((m) => colIndex(m[1]!));
          const fmts = refs.map((rc) => ws.getCell(2, rc).numFmt).filter((f): f is string => !isGeneral(f));
          const pick = fmts.find((f) => /[$€£¥₹]/.test(f)) ?? fmts[0];
          if (pick) for (let r = 2; r <= last; r++) ws.getCell(r, ci).numFmt = pick;
        }
        const h = ws.getCell(1, ci); const prev = ws.getCell(1, ci - 1);
        if (ci > 1) { h.font = prev.font; h.fill = prev.fill; h.alignment = prev.alignment; }
        ws.getColumn(ci).width = Number(op.width) || Math.max(12, String(op.header).length + 4);
        break;
      }
      case 'addSheet': fresh.add(buildSheet(wb, { name: op.name, rows: op.rows, columns: op.columns, header: op.header, totals: op.totals })); break;
      case 'deleteSheet': wb.removeWorksheet(sheetOf(wb, op.sheet).id); break;
      case 'renameSheet': sheetOf(wb, op.sheet).name = String(need(op.name, 'name')).slice(0, 31); break;
      case 'formatHeader': applyHeaderStyle(sheetOf(wb, op.sheet), op); break;
      case 'addTotals': { const ws = sheetOf(wb, op.sheet); addTotals(ws, need(op.columns, 'columns') as string[], op.label, op.function); for (const l of op.columns as string[]) touch(ws, colIndex(l)); break; }
      case 'setColumnFormat': { const ws = sheetOf(wb, op.sheet); const ci = colIndex(String(need(op.column, 'column'))); ws.getColumn(ci).numFmt = String(op.format); for (let r = 2; r <= ws.rowCount; r++) ws.getCell(r, ci).numFmt = String(op.format); break; }
      case 'setColumnWidth': sheetOf(wb, op.sheet).getColumn(colIndex(String(need(op.column, 'column')))).width = Number(op.width); break;
      case 'freeze': sheetOf(wb, op.sheet).views = [{ state: 'frozen', ySplit: Number(op.row) || 1 }]; break;
      case 'deleteRow': sheetOf(wb, op.sheet).spliceRows(Number(need(op.row, 'row')), 1); break;
      case 'deleteColumn': sheetOf(wb, op.sheet).spliceColumns(colIndex(String(need(op.column, 'column'))), 1); break;
      default: throw new ToolError(`unknown op "${kind}"`);
    }
    done.push(kind);
  }
  fillFormulaResults(wb, 'all');
  for (const ws of fresh) applyAutoFormats(ws);
  for (const [ws, cols] of touched) if (!fresh.has(ws)) applyAutoFormats(ws, cols);
  wb.calcProperties = { ...(wb.calcProperties ?? {}), fullCalcOnLoad: true };
  await wb.xlsx.writeFile(out);
  return { ok: true, path: out, applied: done, sheets: wb.worksheets.map((w) => ({ name: w.name, rows: w.rowCount, columns: w.columnCount })) };
};
