// CSV / TSV for previews: RFC-4180 quoting, a delimiter guess for .txt-ish input, and hard row / column caps that are
// reported (never silent). Input is already bounded text (projects.readFile caps at 512 KB).
import { PREVIEW_LIMITS } from "./limits";

export interface DelimitedTable {
  readonly header: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  /** Rows in the parsed text (header excluded). Exact unless `textTruncated`. */
  readonly totalRows: number;
  readonly totalCols: number;
  readonly moreRows: boolean;
  readonly moreCols: boolean;
  /** The file was longer than what was read, so `totalRows` is a lower bound. */
  readonly textTruncated: boolean;
}

export function delimiterFor(path: string, sample: string): "," | "\t" | ";" {
  if (/\.tsv$/i.test(path)) return "\t";
  const line = sample.slice(0, 2000).split(/\r?\n/, 1)[0] ?? "";
  const counts = { ",": 0, "\t": 0, ";": 0 };
  for (const char of line) if (char in counts) counts[char as keyof typeof counts] += 1;
  if (counts["\t"] > counts[","] && counts["\t"] >= counts[";"]) return "\t";
  if (counts[";"] > counts[","]) return ";";
  return ",";
}

export function parseDelimited(
  text: string,
  delimiter: string,
  options: {
    readonly rows?: number;
    readonly cols?: number;
    readonly textTruncated?: boolean;
  } = {},
): DelimitedTable {
  const maxRows = options.rows ?? PREVIEW_LIMITS.delimitedRows;
  const maxCols = options.cols ?? PREVIEW_LIMITS.delimitedCols;
  const all: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let widest = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    widest = Math.max(widest, row.length);
    all.push(row);
    row = [];
  };
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) pushField();
    else if (char === "\n") pushRow();
    else if (char === "\r") {
      if (source[index + 1] === "\n") index += 1;
      pushRow();
    } else field += char;
    index += 1;
  }
  if (field !== "" || row.length > 0) pushRow();
  if (all.length === 0) {
    return {
      header: [],
      rows: [],
      totalRows: 0,
      totalCols: 0,
      moreRows: false,
      moreCols: false,
      textTruncated: Boolean(options.textTruncated),
    };
  }
  const clip = (cells: string[]) => cells.slice(0, maxCols);
  const header = clip(all[0]!);
  const body = all.slice(1);
  // A file cut mid-line leaves a ragged last row; it is dropped (and reported through textTruncated).
  const kept = options.textTruncated && body.length > 0 ? body.slice(0, -1) : body;
  return {
    header,
    rows: kept.slice(0, maxRows).map(clip),
    totalRows: kept.length,
    totalCols: widest,
    moreRows: kept.length > maxRows,
    moreCols: widest > maxCols,
    textTruncated: Boolean(options.textTruncated),
  };
}
