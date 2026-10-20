// Kora's document skills pack: our own SKILL.md texts for the `kora blob-tools` document commands (written for Kora,
// no third-party skill text). `{{KORA}}` is replaced at install time with the command that runs this install's CLI
// (`kora`, or an absolute node + kora.js path), so the same text works in a shell with or without the shim.
export interface DocSkill { name: string; description: string; body: string }

export const DOC_SKILLS: DocSkill[] = [
  {
    name: 'kora-spreadsheets',
    description: 'Create, read and edit Excel spreadsheets (.xlsx): tables, formulas, totals, number formats, new columns or sheets. Use whenever the user wants a budget, tracker, comparison table or any data in a spreadsheet, or hands you an .xlsx/.csv to change.',
    body: `# Spreadsheets (.xlsx)

Save the file in \`outputs/\`. Never leave a half-built file: build it, read it back once, then tell the user.

## Pick the tool
1. **Prefer the built-in command** for the usual table-with-formulas case, and for ANY change to a spreadsheet that already exists. It needs no install, and it stores a calculated value next to every formula, so the file shows real numbers in the chat preview, in Quick Look and in any viewer.
2. Use Python only for what it cannot do (charts, conditional formatting, pivots), and only if \`python3 -c 'import openpyxl'\` succeeds. **openpyxl writes formulas with NO calculated value**, so previews show 0 or blank. If you use it, either write the computed number in the cell (and put the formula text in a neighbouring note or header), or run the file through \`{{KORA}} blob-tools xlsx edit --json '{"path":"<file>","ops":[]}'\` afterwards: it recalculates and stores every formula's value.

The command:

\`\`\`
{{KORA}} blob-tools xlsx write --json '<input>'
{{KORA}} blob-tools xlsx read  --json '{"path":"outputs/budget.xlsx"}'
{{KORA}} blob-tools xlsx edit  --json '<input>'
\`\`\`
Input is JSON (inline with \`--json\`, a file with \`--file\`, or stdin). Output is JSON: \`{"ok":true,...}\` or \`{"ok":false,"error":"..."}\` - read the error and fix the input.

## write
\`\`\`
{"path":"outputs/budget.xlsx","sheets":[{"name":"Budget",
  "columns":[{"header":"Item"},{"header":"Qty"},{"header":"Price","format":"$#,##0.00"}],
  "rows":[["Pens",4,2.5],["Paper",2,10]],
  "totals":{"label":"Total","columns":["B","C"]}}]}
\`\`\`
- A string starting with \`=\` is a formula (\`"=B2*C2"\`). Per-row formula columns: use \`edit\` \`addColumn\` with \`"formula":"=B{row}*C{row}"\`.
- Sheet options: \`cells\` ({"E2":"=B2*C2"}), \`columnFormats\` ({"C":"0.0%"}), \`header\` ({"bold":true,"fill":"DDEEFF"}) or \`false\`, \`freeze\`, \`autoFilter\`, \`totals\` (function SUM|AVERAGE|MIN|MAX|COUNT).
- It refuses to replace an existing file unless you pass \`"overwrite":true\`.

## edit (changes the file in place, or to \`out\`)
Ops: setCell, addRow, addColumn, addSheet, deleteSheet, renameSheet, formatHeader, addTotals, setColumnFormat, setColumnWidth, freeze, deleteRow, deleteColumn. Example: \`{"path":"outputs/budget.xlsx","ops":[{"op":"addColumn","sheet":"Budget","header":"Cost","formula":"=B{row}*C{row}","format":"$#,##0.00"}]}\`.

## read
Returns rows, plus every formula in \`formulas\`. \`maxRows\` (default 200), \`range\` ("A1:D20"), \`sheet\`. For chart data: \`"series":{"category":"A2:A9","values":"B2:B9"}\`.

## Rules
- Formula results are stored when you write or edit through the command (SUM, AVERAGE, MIN, MAX, COUNT, IF, ROUND, arithmetic, percentages, cell and cross-sheet references, ranges). Read the file back and quote only numbers you saw. A function the command cannot calculate (e.g. VLOOKUP) is left for Excel to compute on open: say so.
- **Changing a spreadsheet the user already has** ("add a savings column"): use \`edit\`, write the result to the SAME file (or an \`out\` next to it if they want the original kept), then call \`attach_output\` with that spreadsheet so the chat gets a fresh card - the earlier card shows the old version. Attach the deliverable only: never the helper script you used to build it (\`.py\`, \`.sh\`, scratch files) unless the user asked for the script.
- **Number formats**: money columns get a currency format and big numbers get thousands separators - the command does this by itself when the header says so ("Amount (USD)", "Price", "Cost", "Savings": \`$#,##0.00\` / \`#,##0\`), and a column computed from a formatted one copies its format. Say the currency in the header ("Amount (USD)") so the symbol is right, or pass \`format\` / \`columnFormats\` yourself (\`0.0%\` for percentages, \`yyyy-mm-dd\` for dates). With Python/openpyxl set \`cell.number_format\` - never leave currency as a bare number.
- Keep one header row, one table per sheet, units in the header ("Price (USD)"). Check the totals with a quick calculation of your own before reporting.
- CSV in or out: read it as text and write the .xlsx with \`write\`; do not paste a CSV into a cell.`,
  },
  {
    name: 'kora-word-documents',
    description: 'Create, read and edit Word documents (.docx): memos, reports, letters, one-pagers with headings, lists, tables and images. Use when the user asks for a Word file or hands you a .docx.',
    body: `# Word documents (.docx)

Write the file into \`outputs/\`. For a plain draft the user will paste elsewhere, Markdown in the chat is better - only make a .docx when they asked for a file.

## Commands
\`\`\`
{{KORA}} blob-tools docx write --json '<input>'
{{KORA}} blob-tools docx read  --json '{"path":"outputs/memo.docx"}'
{{KORA}} blob-tools docx edit  --json '<input>'
\`\`\`
JSON in, JSON out (\`{"ok":true,...}\` or \`{"ok":false,"error":"..."}\`).

## write
\`\`\`
{"path":"outputs/trip-memo.docx","title":"Lisbon trip","blocks":[
  {"type":"heading","level":1,"text":"Plan"},
  {"type":"paragraph","text":"We leave on Friday."},
  {"type":"paragraph","runs":[{"text":"Important: ","bold":true},{"text":"bring passports."}]},
  {"type":"bullets","items":["Book hotel","Pack"]},
  {"type":"numbered","items":["First","Second"]},
  {"type":"table","header":["Day","City"],"rows":[["Fri","Lisbon"]]},
  {"type":"image","path":"files/map.png","width":480},
  {"type":"pagebreak"}]}
\`\`\`
Blocks: heading (level 1-4), paragraph (text or runs; align left|center|right|justify), bullets, numbered, table, image, pagebreak. Refuses to replace a file unless \`"overwrite":true\`.

## read / edit
- \`read\` returns paragraphs with their style (Heading1, Normal...), tables as arrays, and the whole text. Read before you edit.
- \`edit\` replaces text that sits inside one formatting run (\`"replacements":[{"find":"Friday","replace":"Saturday"}]\`) and can append plain paragraphs (\`"appendParagraphs":[...]\`). For a larger restructure, read the document and write a new one next to it (never overwrite the user's original without asking).

## Rules
- Structure first: headings carry the outline, short paragraphs, tables for comparisons. No decorative filler.
- If \`python3 -c 'import docx'\` works you may use python-docx for styling the commands do not cover.`,
  },
  {
    name: 'kora-slides',
    description: 'Create and read PowerPoint decks (.pptx): title slide, bullet slides, tables, bar/line/pie charts, images and speaker notes. Use when the user wants a presentation or hands you a .pptx.',
    body: `# Slide decks (.pptx)

Save into \`outputs/\`, and attach it. A good deck: one idea per slide, 3-5 short bullets or one visual, a clear title that states the point.

## Commands
\`\`\`
{{KORA}} blob-tools pptx write --json '<input>'
{{KORA}} blob-tools pptx read  --json '{"path":"outputs/deck.pptx"}'
\`\`\`
JSON in, JSON out.

## write
\`\`\`
{"path":"outputs/q3.pptx","title":"Q3 review","slides":[
  {"title":"Q3 review","subtitle":"Team update"},
  {"title":"Revenue grew 18%","bullets":["New plan drove signups","Churn fell to 2%"],"notes":"Say this slowly."},
  {"title":"Monthly revenue","chart":{"type":"bar","labels":["Jul","Aug","Sep"],"series":[{"name":"Revenue","values":[3,4,5]}]}},
  {"title":"Next steps","table":{"header":["Owner","Task"],"rows":[["Sam","Pricing page"]]}},
  {"title":"Screenshot","image":{"path":"files/screen.png"}}]}
\`\`\`
- Slide keys: title, subtitle (first slide), bullets, text, table, chart (bar|line|pie), image, notes.
- Chart numbers come from the user's data: read a spreadsheet with \`{{KORA}} blob-tools xlsx read\` (use its \`series\` option) rather than retyping.
- To change a deck: \`read\` it, then \`write\` a new version with \`"overwrite":true\` or a new name.

## Rules
- Do not invent statistics to fill a slide. If you lack a number, say so in the notes or ask.
- If \`python3 -c 'import pptx'\` works you may use python-pptx for custom layouts.`,
  },
  {
    name: 'kora-pdf-reading',
    description: 'Read the text of a PDF (reports, papers, invoices, contracts, forms) page by page. Use whenever the user shares a .pdf or asks what is in one.',
    body: `# Reading PDFs

\`\`\`
{{KORA}} blob-tools pdf read --json '{"path":"files/report.pdf","pages":"1-5"}'
{{KORA}} blob-tools pdf info --json '{"path":"files/report.pdf"}'
\`\`\`
- \`read\` returns \`pages:[{n,text}]\`, \`totalPages\` and \`hasText\`. \`pages\` accepts "1-3,7"; \`maxChars\` caps the total (default 60000). For a long document, read the outline pages first, then only the pages you need.
- \`hasText: false\` means a scanned PDF with no text layer: tell the user you cannot read it as text. If \`tesseract\` is installed you may OCR it; otherwise do not guess at the content. An image of a page can also be opened with your image-reading tool.
- Quote with the page number ("p. 4"). Tables come out as plain lines; rebuild them carefully and say when columns are uncertain.
- To make a PDF, write the document as .docx or .html in \`outputs/\` and let the user print it to PDF.`,
  },
];

export function renderSkill(s: DocSkill, koraCmd: string): string {
  return `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body.replace(/\{\{KORA\}\}/g, koraCmd)}\n`;
}
