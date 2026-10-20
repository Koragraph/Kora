// `kora blob-tools pptx read|write` - slide decks with pptxgenjs (pure JS). JSON in, JSON out.
//
//   write  {path, overwrite?, title?, slides:[{title?, subtitle?, bullets?:[…], text?, notes?, image?:{path}, table?:{header?,rows},
//           chart?:{type:"bar"|"line"|"pie", labels:[…], series:[{name,values:[…]}], title?}}]}      16:9, one idea per slide
//   read   {path}                 -> {slides:[{n, texts:[…], notes}]}
import fs from 'node:fs';
import { ToolError, assertWritable, need, resolvePath, type Verb } from './util';

type Json = Record<string, any>;
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export const write: Verb = async (input, cwd) => {
  const Pptx = require('pptxgenjs');
  const file = resolvePath(input.path, cwd);
  assertWritable(file, input.overwrite);
  const slides = need(Array.isArray(input.slides) ? (input.slides as Json[]) : undefined, 'slides');
  const pres = new Pptx();
  pres.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pres.author = 'Kora blob';
  if (input.title) pres.title = String(input.title);
  const INK = '1F2024';
  const MUTED = '6B6E76';
  slides.forEach((s, i) => {
    const slide = pres.addSlide();
    const hasTitleOnly = !s.bullets && !s.image && !s.table && !s.chart && !s.text;
    if (i === 0 && (s.subtitle || hasTitleOnly)) {
      slide.addText(String(s.title ?? input.title ?? ''), { x: 0.8, y: 2.4, w: 11.7, h: 1.4, fontSize: 40, bold: true, color: INK, fontFace: 'Helvetica' });
      if (s.subtitle) slide.addText(String(s.subtitle), { x: 0.8, y: 3.9, w: 11.7, h: 0.8, fontSize: 20, color: MUTED, fontFace: 'Helvetica' });
    } else {
      if (s.title) slide.addText(String(s.title), { x: 0.6, y: 0.35, w: 12.1, h: 0.9, fontSize: 30, bold: true, color: INK, fontFace: 'Helvetica' });
      const box = { x: 0.7, y: 1.5, w: 11.9, h: 5.3 };
      if (Array.isArray(s.bullets) && s.bullets.length) slide.addText(s.bullets.map((b: unknown) => ({ text: String(b), options: { bullet: true, breakLine: true } })), { ...box, fontSize: 22, color: INK, fontFace: 'Helvetica', valign: 'top', paraSpaceAfter: 8 });
      else if (s.text) slide.addText(String(s.text), { ...box, fontSize: 22, color: INK, fontFace: 'Helvetica', valign: 'top' });
      if (s.table) {
        const rows = [...(s.table.header ? [(s.table.header as unknown[]).map((h) => ({ text: String(h), options: { bold: true, fill: { color: 'E8E8EC' } } }))] : []), ...((s.table.rows ?? []) as unknown[][]).map((r) => r.map((c) => ({ text: String(c ?? '') })))];
        slide.addTable(rows, { ...box, fontSize: 16, color: INK, border: { type: 'solid', color: 'C8C9CE', pt: 0.5 } });
      }
      if (s.chart) {
        const kind = { bar: pres.charts.BAR, line: pres.charts.LINE, pie: pres.charts.PIE }[String(s.chart.type)] ?? pres.charts.BAR;
        const data = ((s.chart.series ?? []) as Json[]).map((x) => ({ name: String(x.name ?? 'Series'), labels: (s.chart.labels ?? []) as string[], values: (x.values ?? []) as number[] }));
        if (!data.length) throw new ToolError('chart needs series');
        slide.addChart(kind, data, { ...box, showLegend: data.length > 1 || s.chart.type === 'pie', showTitle: !!s.chart.title, title: s.chart.title ? String(s.chart.title) : undefined });
      }
      if (s.image?.path) slide.addImage({ path: resolvePath(s.image.path, cwd), x: 1.2, y: 1.5, w: 10.9, h: 5.3, sizing: { type: 'contain', w: 10.9, h: 5.3 } });
    }
    if (s.notes) slide.addNotes(String(s.notes));
  });
  await pres.writeFile({ fileName: file });
  return { ok: true, path: file, slides: slides.length };
};

export const read: Verb = async (input, cwd) => {
  const JSZip = require('jszip') as typeof import('jszip');
  const file = resolvePath(input.path, cwd);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]));
  if (!names.length) throw new ToolError(`${file} is not a .pptx (no slides)`);
  const texts = (xml: string) => [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unesc(m[1])).filter((t) => t.trim());
  const slides = [];
  for (const n of names) {
    const num = Number(/(\d+)\.xml/.exec(n)![1]);
    const notesEntry = zip.file(`ppt/notesSlides/notesSlide${num}.xml`);
    slides.push({ n: num, texts: texts(await zip.file(n)!.async('string')), notes: notesEntry ? texts(await notesEntry.async('string')).join(' ') : '' });
  }
  return { ok: true, path: file, slides };
};
