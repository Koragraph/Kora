// `kora blob-tools docx read|write|edit` - Word documents with the `docx` npm package (pure JS). JSON in, JSON out.
//
//   write  {path, overwrite?, title?, blocks:[{type:"heading",level:1-4,text} | {type:"paragraph",text | runs:[{text,bold?,italic?,underline?}],align?}
//           | {type:"bullets",items:[…]} | {type:"numbered",items:[…]} | {type:"table",header?:[…],rows:[[…]]} | {type:"image",path,width?}
//           | {type:"pagebreak"}]}
//   read   {path}                 -> {paragraphs:[{style,text}], tables:[[[cell]]], text}
//   edit   {path, out?, replacements?:[{find,replace}], appendParagraphs?:[text]}   (text inside a single run only)
import fs from 'node:fs';
import { ToolError, assertWritable, need, resolvePath, type Verb } from './util';

type Json = Record<string, any>;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export const write: Verb = async (input, cwd) => {
  const d = require('docx') as typeof import('docx');
  const file = resolvePath(input.path, cwd);
  assertWritable(file, input.overwrite);
  const blocks = need(Array.isArray(input.blocks) ? (input.blocks as Json[]) : undefined, 'blocks');
  const HEAD = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4];
  const children: Array<InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>> = [];
  const numbering: Array<{ reference: string; levels: Array<{ level: number; format: any; text: string; alignment: any }> }> = [];
  const runs = (b: Json) => (Array.isArray(b.runs) ? b.runs : [{ text: String(b.text ?? '') }]).map((r: Json) => new d.TextRun({ text: String(r.text ?? ''), bold: r.bold, italics: r.italic, underline: r.underline ? {} : undefined }));
  const align = (a: unknown) => (a === 'center' ? d.AlignmentType.CENTER : a === 'right' ? d.AlignmentType.RIGHT : a === 'justify' ? d.AlignmentType.JUSTIFIED : undefined);
  if (input.title) children.push(new d.Paragraph({ text: String(input.title), heading: d.HeadingLevel.TITLE }));
  for (const b of blocks) {
    switch (String(b.type)) {
      case 'heading': children.push(new d.Paragraph({ children: runs(b), heading: HEAD[Math.min(Math.max(Number(b.level) || 1, 1), 4) - 1] })); break;
      case 'paragraph': children.push(new d.Paragraph({ children: runs(b), alignment: align(b.align), spacing: { after: 120 } })); break;
      case 'bullets': for (const it of (b.items ?? []) as unknown[]) children.push(new d.Paragraph({ text: String(it), bullet: { level: 0 } })); break;
      case 'numbered': {
        const reference = `num${numbering.length + 1}`;
        numbering.push({ reference, levels: [{ level: 0, format: d.LevelFormat.DECIMAL, text: '%1.', alignment: d.AlignmentType.LEFT }] });
        for (const it of (b.items ?? []) as unknown[]) children.push(new d.Paragraph({ text: String(it), numbering: { reference, level: 0 } }));
        break;
      }
      case 'table': {
        const rows: Array<InstanceType<typeof d.TableRow>> = [];
        // Explicit column widths in twips (A4 text width 9026): a percentage width with a 100-twip grid (the library's default)
        // opens fine in Word but renders one-letter-wide columns in Pages / Preview / Quick Look.
        const ncols = Math.max(1, Array.isArray(b.header) ? b.header.length : 0, ...((b.rows ?? []) as unknown[][]).map((r) => r.length));
        const total = 9026;
        const colW = Math.floor(total / ncols);
        const cell = (t: unknown, bold = false) => new d.TableCell({ width: { size: colW, type: d.WidthType.DXA }, children: [new d.Paragraph({ children: [new d.TextRun({ text: String(t ?? ''), bold })] })] });
        if (Array.isArray(b.header)) rows.push(new d.TableRow({ tableHeader: true, children: b.header.map((h: unknown) => cell(h, true)) }));
        for (const r of (b.rows ?? []) as unknown[][]) rows.push(new d.TableRow({ children: r.map((c) => cell(c)) }));
        if (rows.length) children.push(new d.Table({ rows, width: { size: total, type: d.WidthType.DXA }, columnWidths: Array.from({ length: ncols }, () => colW) }));
        children.push(new d.Paragraph({ text: '' }));
        break;
      }
      case 'image': {
        const img = resolvePath(b.path, cwd);
        const w = Number(b.width) || 480;
        const type = /\.jpe?g$/i.test(img) ? 'jpg' : /\.gif$/i.test(img) ? 'gif' : 'png';
        children.push(new d.Paragraph({ children: [new d.ImageRun({ type: type as 'png', data: fs.readFileSync(img), transformation: { width: w, height: Math.round(w * 0.6) } })] }));
        break;
      }
      case 'pagebreak': children.push(new d.Paragraph({ children: [new d.PageBreak()] })); break;
      default: throw new ToolError(`unknown block type "${String(b.type)}"`);
    }
  }
  const doc = new d.Document({ creator: 'Kora blob', title: input.title ? String(input.title) : undefined, numbering: { config: numbering }, sections: [{ children }] });
  fs.writeFileSync(file, await d.Packer.toBuffer(doc));
  return { ok: true, path: file, blocks: blocks.length };
};

async function openZip(file: string): Promise<import('jszip')> {
  const JSZip = require('jszip') as typeof import('jszip');
  return JSZip.loadAsync(fs.readFileSync(file));
}

const textOf = (xml: string): string => unesc([...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((m) => (m[1] !== undefined ? m[1] : ' ')).join(''));

export const read: Verb = async (input, cwd) => {
  const file = resolvePath(input.path, cwd);
  const zip = await openZip(file);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new ToolError(`${file} is not a .docx (no word/document.xml)`);
  const xml = await entry.async('string');
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const paragraphs: Array<{ style: string; text: string }> = [];
  const tables: string[][][] = [];
  const tblRe = /<w:tbl>[\s\S]*?<\/w:tbl>/g;
  for (const t of body.match(tblRe) ?? []) tables.push([...t.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)].map((tr) => [...tr[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((tc) => textOf(tc[0]))));
  for (const p of body.replace(tblRe, '').matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p[0])?.[1] ?? 'Normal';
    const text = textOf(p[0]);
    if (text.trim()) paragraphs.push({ style, text });
  }
  const text = paragraphs.map((p) => p.text).join('\n');
  const max = Math.min(Number(input.maxChars) || 60_000, 400_000);
  return { ok: true, path: file, paragraphs: paragraphs.slice(0, 2000), tables: tables.slice(0, 50), text: text.slice(0, max), truncated: text.length > max };
};

export const edit: Verb = async (input, cwd) => {
  const file = resolvePath(input.path, cwd);
  const out = input.out ? resolvePath(input.out, cwd) : file;
  const zip = await openZip(file);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new ToolError(`${file} is not a .docx`);
  let xml = await entry.async('string');
  const counts: Record<string, number> = {};
  for (const r of (input.replacements ?? []) as Json[]) {
    const find = esc(String(need(r.find, 'find'))); const rep = esc(String(r.replace ?? ''));
    let n = 0;
    xml = xml.split(find).join('\u0000').replace(/\u0000/g, () => { n++; return rep; });
    counts[String(r.find)] = n;
  }
  const extra = ((input.appendParagraphs ?? []) as unknown[]).map((t) => `<w:p><w:r><w:t xml:space="preserve">${esc(String(t))}</w:t></w:r></w:p>`).join('');
  if (extra) {
    const at = xml.lastIndexOf('<w:sectPr');
    xml = at >= 0 ? xml.slice(0, at) + extra + xml.slice(at) : xml.replace('</w:body>', `${extra}</w:body>`);
  }
  zip.file('word/document.xml', xml);
  fs.writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return { ok: true, path: out, replacements: counts, appended: ((input.appendParagraphs ?? []) as unknown[]).length };
};
