const MAX_ROWS = 100;
const MAX_COLUMNS = 30;
const MAX_CELL_LENGTH = 2000;
const BYTE_ORDER_MARK = 0xfeff;

/** A table preview is bounded independently of the source preview's byte limit. */
export function fileViewerDelimiter(file: { name: string; mimeType?: string }): "," | "\t" | null {
  const declared = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (declared === "text/csv") return ",";
  if (declared === "text/tab-separated-values") return "\t";
  const unspecific = declared === "text/plain" || declared === "application/octet-stream";
  if (declared && !unspecific) return null;
  if (/\.csv$/i.test(file.name)) return ",";
  return /\.tsv$/i.test(file.name) ? "\t" : null;
}

/** Preserve quoted delimiters, escaped quotes and multiline cells; raw mode retains all text. */
export function parseDelimitedPreview(text: string, delimiter: "," | "\t") {
  const table = {
    rows: [] as string[][],
    row: [] as string[],
    cell: "",
    quoted: false,
    lost: false,
  };

  const keep = (ch: string) => {
    if (table.cell.length < MAX_CELL_LENGTH) table.cell += ch;
    else table.lost = true;
  };
  const endCell = () => {
    if (table.row.length < MAX_COLUMNS) table.row.push(table.cell);
    else table.lost = true;
    table.cell = "";
  };
  const endRow = () => {
    endCell();
    table.rows.push(table.row);
    table.row = [];
  };

  let i = text.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;
  while (i < text.length) {
    const ch = text[i]!;
    i += 1;
    if (table.quoted) {
      if (ch !== '"') keep(ch);
      else if (text[i] === '"') {
        keep('"');
        i += 1;
      } else table.quoted = false;
      continue;
    }
    if (ch === '"' && table.cell === "") {
      table.quoted = true;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i] === "\n") i += 1;
      endRow();
      if (table.rows.length === MAX_ROWS) {
        return { rows: table.rows, truncated: table.lost || i < text.length };
      }
    } else {
      keep(ch);
    }
  }
  if (table.cell !== "" || table.row.length > 0) endRow();
  return { rows: table.rows, truncated: table.lost || table.quoted };
}
