// `kora blob-tools pdf read|info` - text out of a PDF (unpdf: a serverless pdf.js build, pure JS, no native code).
//   read   {path, pages?:"1-3,7", maxChars?}      -> {pages:[{n,text}], totalPages}
//   info   {path}                                  -> {totalPages, meta}
// A scanned PDF has no text layer: `pages[].text` is empty then - say so, do not guess at the content.
import fs from 'node:fs';
import { need, resolvePath, type Verb } from './util';

function parsePages(spec: unknown, total: number): number[] {
  if (typeof spec !== 'string' || !spec.trim()) return Array.from({ length: total }, (_, i) => i + 1);
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    for (let p = Math.max(1, a); p <= Math.min(total, b); p++) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}

async function open(file: string) {
  const u = require('unpdf') as typeof import('unpdf');
  const pdf = await u.getDocumentProxy(new Uint8Array(fs.readFileSync(file)));
  return { u, pdf };
}

export const read: Verb = async (input, cwd) => {
  const file = resolvePath(input.path, cwd);
  const { u, pdf } = await open(file);
  const { totalPages, text } = await u.extractText(pdf, { mergePages: false });
  const want = parsePages(input.pages, totalPages);
  const budget = Math.min(Number(input.maxChars) || 60_000, 400_000);
  let used = 0; let truncated = false;
  const pages: Array<{ n: number; text: string }> = [];
  for (const n of want) {
    let t = String((text as string[])[n - 1] ?? '').replace(/[ \t]+\n/g, '\n').trim();
    if (used + t.length > budget) { t = t.slice(0, Math.max(0, budget - used)); truncated = true; }
    used += t.length;
    pages.push({ n, text: t });
    if (truncated) break;
  }
  return { ok: true, path: file, totalPages, pages, truncated, hasText: pages.some((p) => p.text.length > 0) };
};

export const info: Verb = async (input, cwd) => {
  const file = resolvePath(need(input.path, 'path'), cwd);
  const { u, pdf } = await open(file);
  const meta = await u.getMeta(pdf).catch(() => ({ info: {} }));
  return { ok: true, path: file, totalPages: pdf.numPages, meta: (meta as { info?: unknown }).info ?? {} };
};
