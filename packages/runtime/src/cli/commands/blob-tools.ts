// `kora blob-tools <xlsx|docx|pptx|pdf> <verb> [--json '<input>' | --file input.json]` - the document tools a blob calls
// from its shell. JSON in (inline, a file, or stdin), JSON out on stdout; exit 1 with {"ok":false,"error":…} on failure.
import fs from 'node:fs';
import type { Command } from '../main';
import { KINDS, runDocTool } from '../../blobs/doctools';

const USAGE = `kora blob-tools <kind> <verb> [--json '<input>' | --file input.json]   (input also read from stdin)

  xlsx  read | write | edit     spreadsheets (formulas, totals, header format, add column/sheet)
  docx  read | write | edit     Word documents (headings, lists, tables, images)
  pptx  read | write            slide decks (titles, bullets, tables, charts, images, notes)
  pdf   read | info             text out of a PDF

Run "kora blob-tools <kind> <verb> --json '{}'" to see what a verb is missing. Paths resolve against the current folder.`;

const cmd: Command = {
  summary: 'Document tools for blobs: xlsx | docx | pptx | pdf, JSON in/out',
  usage: USAGE,
  async run(argv, io) {
    const [kind, verb, ...rest] = argv;
    if (!kind || !verb) { io.out(USAGE + '\n'); return kind ? 2 : 0; }
    if (!KINDS[kind]) { io.err(JSON.stringify({ ok: false, error: `unknown tool "${kind}"` }) + '\n'); return 2; }
    let raw: string | null = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--json') raw = rest[++i] ?? '';
      else if (rest[i] === '--file') { try { raw = fs.readFileSync(rest[++i] ?? '', 'utf8'); } catch (e: any) { io.out(JSON.stringify({ ok: false, error: `cannot read input file: ${e?.message}` }) + '\n'); return 1; } }
    }
    if (raw === null && !process.stdin.isTTY) {
      raw = await new Promise<string>((resolve) => {
        let s = ''; const t = setTimeout(() => resolve(s), 1500);
        process.stdin.setEncoding('utf8').on('data', (c) => { s += c; }).on('end', () => { clearTimeout(t); resolve(s); }).on('error', () => resolve(s));
      });
    }
    let input: Record<string, any> = {};
    if (raw && raw.trim()) { try { input = JSON.parse(raw); } catch (e: any) { io.out(JSON.stringify({ ok: false, error: `input is not valid JSON: ${e?.message}` }) + '\n'); return 1; } }
    const res = await runDocTool(kind, verb, input);
    io.out(JSON.stringify(res) + '\n');
    return res.ok === false ? 1 : 0;
  },
};

export = cmd;
