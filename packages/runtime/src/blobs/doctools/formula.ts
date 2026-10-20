// A small spreadsheet formula evaluator: arithmetic, comparison, & , percentages, cell refs, ranges, cross-sheet refs and the
// everyday functions (SUM AVERAGE MIN MAX COUNT COUNTA PRODUCT ABS ROUND ROUNDUP ROUNDDOWN INT SQRT POWER MOD IF IFERROR
// AND OR NOT CONCATENATE). Used to give formulas a cached value when a writer (openpyxl, a model script) left none, so a
// preview shows 1,240 instead of 0.
// NOTE: apps/web/src/components/blobs/previews/formula.ts is a byte-identical copy (the two packages cannot import each
// other). Change both together; each has the same test.

export type Val = number | string | boolean | null;
export interface Ref { sheet?: string; col: number; row: number }
export interface Resolver {
  /** The value of a cell (formulas already evaluated by the caller). null = empty. Throw FormulaError for an error cell. */
  cell(ref: Ref): Val;
}
export class FormulaError extends Error {
  constructor(public code: string) { super(code); }
}
export type EvalResult = { ok: true; value: Val } | { ok: false; error: string };

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'ref'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };

const colIndex = (l: string): number => l.toUpperCase().split('').reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? '';
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let j = i + 1, s = '';
      for (; j < src.length; j++) { if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j++; continue; } break; } s += src[j]; }
      if (j >= src.length) throw new FormulaError('#NAME?');
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (c === "'") { // 'My Sheet'!A1
      const end = src.indexOf("'", i + 1);
      if (end < 0 || src[end + 1] !== '!') throw new FormulaError('#NAME?');
      const m = /^\$?[A-Za-z]{1,3}\$?\d+/.exec(src.slice(end + 2));
      if (!m) throw new FormulaError('#REF!');
      out.push({ t: 'ref', v: `${src.slice(i, end + 1)}!${m[0]}` }); i = end + 2 + m[0].length; continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num && !/[A-Za-z_$]/.test(src[i - 1] ?? '')) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const word = /^[A-Za-z_$][A-Za-z0-9_.$]*(?:![$]?[A-Za-z]{1,3}[$]?\d+)?/.exec(src.slice(i));
    if (word) {
      const w = word[0];
      if (/^\$?[A-Za-z]{1,3}\$?\d+$/.test(w) || /!/.test(w)) out.push({ t: 'ref', v: w });
      else if (/^(TRUE|FALSE)$/i.test(w)) out.push({ t: 'id', v: w.toUpperCase() });
      else out.push({ t: 'id', v: w.toUpperCase() });
      i += w.length; continue;
    }
    const two = src.slice(i, i + 2);
    if (['<>', '<=', '>='].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/^&=<>(),:%'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new FormulaError('#NAME?');
  }
  return out;
}

function parseRef(s: string): Ref {
  let sheet: string | undefined;
  let a = s;
  const bang = s.lastIndexOf('!');
  if (bang >= 0) { sheet = s.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'"); a = s.slice(bang + 1); }
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(a);
  if (!m) throw new FormulaError('#REF!');
  return { ...(sheet ? { sheet } : {}), col: colIndex(m[1] ?? ''), row: Number(m[2]) };
}

type Arg = Val | Val[]; // a range is a flat list
const MAX_RANGE = 200_000;

export function evaluate(formula: string, r: Resolver): EvalResult {
  try {
    const src = formula.startsWith('=') ? formula.slice(1) : formula;
    const toks = tokenize(src);
    let p = 0;
    const peek = () => toks[p];
    const eat = (v?: string) => { const t = toks[p]; if (!t || (v !== undefined && !(t.t === 'op' && t.v === v))) throw new FormulaError('#NAME?'); p++; return t; };
    const isOp = (v: string) => { const t = toks[p]; return !!t && t.t === 'op' && t.v === v; };

    const num = (v: Arg): number => {
      if (Array.isArray(v)) v = v[0] ?? null;
      if (v === null) return 0;
      if (typeof v === 'number') return v;
      if (typeof v === 'boolean') return v ? 1 : 0;
      const n = Number(String(v).trim());
      if (String(v).trim() === '' || !Number.isFinite(n)) throw new FormulaError('#VALUE!');
      return n;
    };
    const scalar = (v: Arg): Val => (Array.isArray(v) ? (v[0] ?? null) : v);
    const text = (v: Arg): string => { const s = scalar(v); return s === null ? '' : typeof s === 'boolean' ? (s ? 'TRUE' : 'FALSE') : String(s); };
    const nums = (args: Arg[]): number[] => { // numbers from ranges only count when numeric; direct args coerce
      const out: number[] = [];
      for (const a of args) {
        if (Array.isArray(a)) { for (const v of a) if (typeof v === 'number') out.push(v); }
        else if (a !== null) out.push(num(a));
      }
      return out;
    };
    const truthy = (v: Arg): boolean => { const s = scalar(v); return typeof s === 'string' ? s.toUpperCase() === 'TRUE' : !!num(s); };

    const at = (a: Arg[], i: number): Arg => a[i] ?? null;
    const FN: Record<string, (a: Arg[]) => Arg> = {
      SUM: (a) => nums(a).reduce((x, y) => x + y, 0),
      PRODUCT: (a) => { const n = nums(a); return n.length ? n.reduce((x, y) => x * y, 1) : 0; },
      AVERAGE: (a) => { const n = nums(a); if (!n.length) throw new FormulaError('#DIV/0!'); return n.reduce((x, y) => x + y, 0) / n.length; },
      MIN: (a) => { const n = nums(a); return n.length ? Math.min(...n) : 0; },
      MAX: (a) => { const n = nums(a); return n.length ? Math.max(...n) : 0; },
      COUNT: (a) => a.reduce<number>((c, x) => c + (Array.isArray(x) ? x.filter((v) => typeof v === 'number').length : x !== null && Number.isFinite(Number(x)) ? 1 : 0), 0),
      COUNTA: (a) => a.reduce<number>((c, x) => c + (Array.isArray(x) ? x.filter((v) => v !== null && v !== '').length : x !== null ? 1 : 0), 0),
      ABS: (a) => Math.abs(num(at(a, 0))),
      SQRT: (a) => { const n = num(at(a, 0)); if (n < 0) throw new FormulaError('#NUM!'); return Math.sqrt(n); },
      POWER: (a) => num(at(a, 0)) ** num(at(a, 1)),
      MOD: (a) => { const d = num(at(a, 1)); if (d === 0) throw new FormulaError('#DIV/0!'); const n = num(at(a, 0)); return n - d * Math.floor(n / d); },
      INT: (a) => Math.floor(num(at(a, 0))),
      ROUND: (a) => { const f = 10 ** Math.trunc(num(a[1] ?? 0)); const n = num(at(a, 0)) * f; return (Math.sign(n) * Math.round(Math.abs(n) + 1e-9)) / f; },
      ROUNDUP: (a) => { const f = 10 ** Math.trunc(num(a[1] ?? 0)); const n = num(at(a, 0)) * f; return (Math.sign(n) * Math.ceil(Math.abs(n) - 1e-9)) / f; },
      ROUNDDOWN: (a) => { const f = 10 ** Math.trunc(num(a[1] ?? 0)); const n = num(at(a, 0)) * f; return (Math.sign(n) * Math.floor(Math.abs(n) + 1e-9)) / f; },
      IF: (a) => (truthy(at(a, 0)) ? (a[1] ?? true) : (a[2] ?? false)),
      AND: (a) => a.flat().every((v) => truthy(v)),
      OR: (a) => a.flat().some((v) => truthy(v)),
      NOT: (a) => !truthy(at(a, 0)),
      CONCATENATE: (a) => a.map(text).join(''),
      CONCAT: (a) => a.flat().map(text).join(''),
    };

    const cellVal = (ref: Ref): Val => r.cell(ref);
    const range = (a: Ref, b: Ref): Val[] => {
      const r1 = Math.min(a.row, b.row), r2 = Math.max(a.row, b.row), c1 = Math.min(a.col, b.col), c2 = Math.max(a.col, b.col);
      if ((r2 - r1 + 1) * (c2 - c1 + 1) > MAX_RANGE) throw new FormulaError('#REF!');
      const out: Val[] = [];
      for (let row = r1; row <= r2; row++) for (let col = c1; col <= c2; col++) out.push(cellVal({ ...(a.sheet ? { sheet: a.sheet } : {}), col, row }));
      return out;
    };

    const cmp = (): Arg => {
      let left = concat();
      for (;;) {
        const t = peek();
        if (!t || t.t !== 'op' || !['=', '<>', '<', '>', '<=', '>='].includes(t.v)) return left;
        p++;
        const right = concat();
        const a = scalar(left), b = scalar(right);
        const both = typeof a === 'string' && typeof b === 'string';
        const x: number | string = both ? (a as string).toLowerCase() : a === null ? (typeof b === 'string' ? '' : 0) : typeof a === 'string' ? a : num(a);
        const y: number | string = both ? (b as string).toLowerCase() : b === null ? (typeof a === 'string' ? '' : 0) : typeof b === 'string' ? b : num(b);
        const ordered = typeof x === typeof y ? (x < y ? -1 : x > y ? 1 : 0) : typeof x === 'string' ? 1 : -1; // text sorts after numbers
        left = t.v === '=' ? ordered === 0 : t.v === '<>' ? ordered !== 0 : t.v === '<' ? ordered < 0 : t.v === '>' ? ordered > 0 : t.v === '<=' ? ordered <= 0 : ordered >= 0;
      }
    };
    const concat = (): Arg => {
      let left = add();
      while (isOp('&')) { p++; left = text(left) + text(add()); }
      return left;
    };
    const add = (): Arg => {
      let left = mul();
      for (;;) {
        if (isOp('+')) { p++; left = num(left) + num(mul()); }
        else if (isOp('-')) { p++; left = num(left) - num(mul()); }
        else return left;
      }
    };
    const mul = (): Arg => {
      let left = pow();
      for (;;) {
        if (isOp('*')) { p++; left = num(left) * num(pow()); }
        else if (isOp('/')) { p++; const d = num(pow()); if (d === 0) throw new FormulaError('#DIV/0!'); left = num(left) / d; }
        else return left;
      }
    };
    // Excel: unary minus binds tighter than ^ (-2^2 = 4) and ^ is left-associative (2^3^2 = 64)
    const unary = (): Arg => {
      if (isOp('-')) { p++; return -num(unary()); }
      if (isOp('+')) { p++; return unary(); }
      return postfix();
    };
    const pow = (): Arg => {
      let base = unary();
      while (isOp('^')) { p++; base = num(base) ** num(unary()); }
      return base;
    };
    const postfix = (): Arg => {
      let v = primary();
      while (isOp('%')) { p++; v = num(v) / 100; }
      return v;
    };
    const primary = (): Arg => {
      const t = toks[p];
      if (!t) throw new FormulaError('#NAME?');
      if (t.t === 'num') { p++; return t.v; }
      if (t.t === 'str') { p++; return t.v; }
      if (t.t === 'op' && t.v === '(') { p++; const v = cmp(); eat(')'); return v; }
      if (t.t === 'ref') {
        p++;
        const a = parseRef(t.v);
        if (isOp(':')) { p++; const n = toks[p]; if (!n || n.t !== 'ref') throw new FormulaError('#REF!'); p++; return range(a, { ...parseRef(n.v), ...(a.sheet ? { sheet: a.sheet } : {}) }); }
        return cellVal(a);
      }
      if (t.t === 'id') {
        p++;
        if (t.v === 'TRUE') return true;
        if (t.v === 'FALSE') return false;
        if (!isOp('(')) throw new FormulaError('#NAME?');
        p++;
        const fn = FN[t.v] ?? (t.v === 'IFERROR' ? null : undefined);
        if (fn === undefined) throw new FormulaError('#NAME?');
        const args: Arg[] = [];
        if (t.v === 'IFERROR') { // lazy: the first argument may be an error
          const save = p;
          let first: Arg | FormulaError;
          try { first = cmp(); } catch (e) { if (!(e instanceof FormulaError)) throw e; first = e; }
          // skip to the comma at depth 0 if the first arg threw midway
          if (first instanceof FormulaError) { p = save; let depth = 0; while (p < toks.length) { const k = toks[p]; if (!k) break; if (k.t === 'op' && k.v === '(') depth++; else if (k.t === 'op' && k.v === ')') { if (depth === 0) break; depth--; } else if (k.t === 'op' && k.v === ',' && depth === 0) break; p++; } }
          eat(',');
          const alt = cmp();
          eat(')');
          return first instanceof FormulaError ? alt : first;
        }
        if (!isOp(')')) { for (;;) { args.push(isOp(',') || isOp(')') ? null : cmp()); if (isOp(',')) { p++; continue; } break; } }
        eat(')');
        return fn!(args);
      }
      throw new FormulaError('#NAME?');
    };

    const v = cmp();
    if (p < toks.length) throw new FormulaError('#NAME?');
    const out = scalar(v);
    if (typeof out === 'number' && !Number.isFinite(out)) throw new FormulaError('#NUM!');
    return { ok: true, value: out };
  } catch (e) {
    if (e instanceof FormulaError) return { ok: false, error: e.code };
    return { ok: false, error: '#VALUE!' };
  }
}

export { colIndex as formulaColIndex };
