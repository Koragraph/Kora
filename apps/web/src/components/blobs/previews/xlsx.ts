// A dependency-free .xlsx reader for previews. It reads the workbook structure, then ONLY the top rows of one sheet
// (inflating the sheet XML until enough rows have arrived), so a 200 MB export costs the same as a small one. Dates
// and a few number formats are rendered; formulas show their cached value. A formula with NO cached value (openpyxl and
// most model scripts store none, which used to preview as 0) is evaluated here from the cells that are loaded: arithmetic,
// cell refs, ranges, SUM/AVERAGE/MIN/MAX/IF/ROUND and friends (./formula.ts). When it cannot be computed honestly (an
// unsupported function, a range reaching past the rows the preview read) the formula text is shown instead of a guess.
import { PREVIEW_LIMITS, PreviewError } from "./limits";
import { attributes, decodeXmlEntities, textRuns } from "./xml";
import { openZip, readZipText, type ZipArchive } from "./zip";
import { evaluate, FormulaError, type Ref, type Val } from "./formula";

export interface SheetRef {
  readonly name: string;
  readonly path: string;
}

export interface SheetData {
  readonly name: string;
  /** Rendered rows (cells already formatted). Gaps are padded with empty strings. */
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  /** 1-based sheet row number of each rendered row (sheets are sparse). */
  readonly rowNumbers: ReadonlyArray<number>;
  /** Same shape as `rows`: the formula text ("=SUM(B2:B9)") of a formula cell, "" elsewhere. Shown on hover. */
  readonly formulas: ReadonlyArray<ReadonlyArray<string>>;
  /** Used range from the sheet's `<dimension>`, when the file records it. */
  readonly totalRows: number | null;
  readonly totalCols: number | null;
  /** True when rows exist beyond the ones rendered. */
  readonly moreRows: boolean;
  /** True when columns exist beyond the ones rendered. */
  readonly moreCols: boolean;
}

export interface Workbook {
  readonly sheets: ReadonlyArray<SheetRef>;
  readSheet(
    index: number,
    limits?: { readonly rows?: number; readonly cols?: number },
  ): Promise<SheetData>;
}

const XL = "xl/";

function resolveTarget(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `${XL}${target}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

/** "AB12" -> { col: 27 (0-based), row: 12 }. */
export function parseCellRef(ref: string): { col: number; row: number } | null {
  const match = /^([A-Za-z]{1,3})(\d+)$/.exec(ref);
  if (!match) return null;
  let col = 0;
  for (const char of match[1]!.toUpperCase()) col = col * 26 + (char.charCodeAt(0) - 64);
  return { col: col - 1, row: Number.parseInt(match[2]!, 10) };
}

export function columnLabel(index: number): string {
  let n = index + 1;
  let label = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

// ── number formats ────────────────────────────────────────────────────────────────────────────────────────────

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);

function customFormatIsDate(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  return /[ymdhs]/i.test(stripped) && !/^[#0?,.%\s-]*$/.test(stripped);
}

type CellFormat = { readonly date: true } | { readonly date: false; readonly code: string | null };

interface Styles {
  /** cellXfs index -> number format (a date, or the Excel format code; null = General). */
  readonly formatOf: (styleIndex: number) => CellFormat;
}

/** Excel's built-in numeric formats (ids that have no <numFmt> in styles.xml). */
const BUILTIN_CODES: Readonly<Record<number, string>> = {
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  5: "$#,##0;($#,##0)",
  6: "$#,##0;($#,##0)",
  7: "$#,##0.00;($#,##0.00)",
  8: "$#,##0.00;($#,##0.00)",
  9: "0%",
  10: "0.00%",
  37: "#,##0;(#,##0)",
  38: "#,##0;(#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;(#,##0.00)",
  41: "#,##0",
  42: "$#,##0",
  43: "#,##0.00",
  44: "$#,##0.00",
};

function parseStyles(xml: string | null): Styles {
  if (xml === null) return { formatOf: () => ({ date: false, code: null }) };
  const custom = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const attrs = attributes(match[0]);
    const id = Number.parseInt(attrs.numFmtId ?? "", 10);
    if (Number.isFinite(id) && attrs.formatCode !== undefined) custom.set(id, attrs.formatCode);
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  const formats: CellFormat[] = [];
  for (const match of cellXfs.matchAll(/<xf\b[^>]*>/g)) {
    const id = Number.parseInt(attributes(match[0]).numFmtId ?? "0", 10);
    const code = custom.get(id);
    if (code !== undefined) {
      formats.push(customFormatIsDate(code) ? { date: true } : { date: false, code });
    } else if (BUILTIN_DATE_FORMATS.has(id)) formats.push({ date: true });
    else formats.push({ date: false, code: BUILTIN_CODES[id] ?? null });
  }
  return { formatOf: (index) => formats[index] ?? { date: false, code: null } };
}

const MS_PER_DAY = 86_400_000;

export function excelSerialToText(serial: number, date1904: boolean): string {
  if (!Number.isFinite(serial)) return String(serial);
  const epoch = Date.UTC(1899, 11, 30) + (date1904 ? 1462 * MS_PER_DAY : 0);
  const date = new Date(epoch + Math.round(serial * MS_PER_DAY));
  if (Number.isNaN(date.getTime())) return String(serial);
  const iso = date.toISOString();
  const hasTime = Math.abs(serial - Math.floor(serial)) > 1e-9;
  return hasTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/**
 * Apply an Excel number format code to a value: currency ("$#,##0.00", "[$€-407] #,##0.00"), percent, thousands
 * separators, fixed decimals, literal text and the negative/zero sections. Null when the code has no numeric part
 * (the caller shows the plain number).
 */
export function applyNumberFormat(value: number, code: string): string | null {
  const sections = code.split(";");
  let section = sections[0] ?? code;
  let negativeHandled = false;
  if (value < 0 && sections.length >= 2) {
    section = sections[1]!;
    negativeHandled = true;
  } else if (value === 0 && sections.length >= 3) section = sections[2]!;
  const cleaned = section
    .replace(/\[\$([^\-\]]*)(?:-[^\]]*)?\]/g, "$1")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/_.|\*./g, "");
  const match = /[#0?][#0?,]*(?:\.[0#?]*)?|\.[0#?]+/.exec(cleaned);
  if (!match) return null;
  const literal = (t: string) => t.replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1");
  const prefix = literal(cleaned.slice(0, match.index));
  const suffix = literal(cleaned.slice(match.index + match[0].length));
  const [intPart = "", decPart = ""] = match[0].split(".");
  const maxDec = decPart.replace(/[^0#?]/g, "").length;
  const minDec = (decPart.match(/0/g) ?? []).length;
  const grouping = intPart.includes(",");
  const scaled = /%/.test(prefix + suffix) ? value * 100 : value;
  const text = Math.abs(scaled).toLocaleString("en-US", {
    minimumFractionDigits: minDec,
    maximumFractionDigits: maxDec,
    useGrouping: grouping,
  });
  const sign = value < 0 && !negativeHandled ? "-" : "";
  return `${sign}${prefix}${text}${suffix}`.trim();
}

function formatNumber(raw: string, format: CellFormat, date1904: boolean): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  if (format.date) return excelSerialToText(value, date1904);
  if (format.code !== null) {
    const formatted = applyNumberFormat(value, format.code);
    if (formatted !== null) return formatted;
  }
  return String(Number.parseFloat(value.toPrecision(12)));
}

// ── workbook ──────────────────────────────────────────────────────────────────────────────────────────────────

async function readSharedStrings(
  archive: ZipArchive,
  needed: ReadonlySet<number>,
): Promise<Map<number, string>> {
  const strings = new Map<number, string>();
  if (needed.size === 0 || !archive.entries.has(`${XL}sharedStrings.xml`)) return strings;
  let highest = 0;
  for (const index of needed) highest = Math.max(highest, index);
  const text = await readZipText(archive, `${XL}sharedStrings.xml`, {
    until: (soFar) => {
      // Stop once the highest needed <si> has fully arrived.
      let count = 0;
      let at = -1;
      while ((at = soFar.indexOf("</si>", at + 1)) !== -1) count += 1;
      return count > highest;
    },
  });
  if (text === null) return strings;
  let index = 0;
  for (const match of text.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    if (needed.has(index)) {
      // Phonetic runs (<rPh>) are furigana, not cell text.
      const body = (match[1] ?? "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
      strings.set(index, textRuns(body, "t"));
    }
    index += 1;
    if (index > highest) break;
  }
  return strings;
}

export async function openWorkbook(bytes: Uint8Array): Promise<Workbook> {
  const archive = openZip(bytes);
  const workbookXml = await readZipText(archive, `${XL}workbook.xml`);
  if (workbookXml === null) {
    throw new PreviewError("corrupt", "This does not look like an Excel workbook.");
  }
  const rels = (await readZipText(archive, `${XL}_rels/workbook.xml.rels`)) ?? "";
  const targetById = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const attrs = attributes(match[0]);
    if (attrs.Id !== undefined && attrs.Target !== undefined)
      targetById.set(attrs.Id, attrs.Target);
  }
  const sheets: SheetRef[] = [];
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    const attrs = attributes(match[0]);
    if (attrs.state === "hidden" || attrs.state === "veryHidden") continue;
    const target = targetById.get(attrs["r:id"] ?? "");
    if (!target || attrs.name === undefined) continue;
    sheets.push({ name: attrs.name, path: resolveTarget(target) });
  }
  if (sheets.length === 0)
    throw new PreviewError("corrupt", "This workbook has no visible sheets.");
  const date1904 = /<workbookPr\b[^>]*date1904\s*=\s*["'](?:1|true)["']/.test(workbookXml);
  const styles = parseStyles(await readZipText(archive, `${XL}styles.xml`));

  return {
    sheets: sheets.slice(0, PREVIEW_LIMITS.maxSheets),
    async readSheet(index, limits = {}) {
      const sheet = sheets[index];
      if (!sheet) throw new PreviewError("not_found", "That sheet is not in the workbook.");
      const maxRows = limits.rows ?? PREVIEW_LIMITS.sheetRows;
      const maxCols = limits.cols ?? PREVIEW_LIMITS.sheetCols;
      let rowCount = 0;
      let scanned = 0;
      // Need maxRows complete rows plus the start of one more, to know there are more.
      const xml = await readZipText(archive, sheet.path, {
        until: (soFar) => {
          let at = scanned;
          while ((at = soFar.indexOf("</row>", at)) !== -1) {
            rowCount += 1;
            at += 6;
            scanned = at;
          }
          return rowCount > maxRows;
        },
      });
      if (xml === null) throw new PreviewError("corrupt", "A sheet in this workbook is missing.");
      return parseSheetXml(sheet.name, xml, { maxRows, maxCols, styles, date1904, archive });
    },
  };
}

interface ParsedCell {
  readonly col: number;
  /** "formula" = a formula the file stored no value for. */
  readonly kind: "s" | "text" | "number" | "bool" | "error" | "formula";
  readonly raw: string;
  readonly style: number;
  readonly formula?: string;
}

const UNKNOWN = "#UNKNOWN";

async function parseSheetXml(
  name: string,
  xml: string,
  context: {
    maxRows: number;
    maxCols: number;
    styles: Styles;
    date1904: boolean;
    archive: ZipArchive;
  },
): Promise<SheetData> {
  const dimension = /<dimension\b[^>]*>/.exec(xml);
  let totalRows: number | null = null;
  let totalCols: number | null = null;
  if (dimension) {
    const ref = attributes(dimension[0]).ref;
    const [from, to = from] = (ref ?? "").split(":");
    const a = from ? parseCellRef(from) : null;
    const b = to ? parseCellRef(to) : null;
    if (a && b) {
      totalRows = b.row - a.row + 1;
      totalCols = b.col - a.col + 1;
    }
  }

  const rawRows: Array<{ number: number; cells: ParsedCell[] }> = [];
  const neededStrings = new Set<number>();
  let moreRows = false;
  let moreCols = false;
  let sequentialRow = 0;
  let maxColSeen = 0;
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowAttrs = attributes(rowMatch[1] ?? "");
    sequentialRow += 1;
    const rowNumber = Number.parseInt(rowAttrs.r ?? "", 10) || sequentialRow;
    sequentialRow = rowNumber;
    if (rawRows.length >= context.maxRows) {
      moreRows = true;
      break;
    }
    const cells: ParsedCell[] = [];
    let nextCol = 0;
    for (const cellMatch of (rowMatch[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = attributes(cellMatch[1] ?? "");
      const ref = attrs.r ? parseCellRef(attrs.r) : null;
      const col = ref ? ref.col : nextCol;
      nextCol = col + 1;
      maxColSeen = Math.max(maxColSeen, col + 1);
      if (col >= context.maxCols) {
        moreCols = true;
        continue;
      }
      const body = cellMatch[2] ?? "";
      const type = attrs.t ?? "n";
      const style = Number.parseInt(attrs.s ?? "0", 10) || 0;
      if (type === "inlineStr") {
        cells.push({ col, kind: "text", raw: textRuns(body, "t"), style });
        continue;
      }
      const fMatch = /<f\b[^>]*?(?:\/>|>([\s\S]*?)<\/f>)/.exec(body);
      const formula = fMatch ? decodeXmlEntities(fMatch[1] ?? "").trim() : "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const fx = formula ? { formula } : {};
      // `<v></v>` / `<v/>` / no <v>: the writer stored no result. With a formula it is computed below; without, it is empty.
      if (v === undefined || (v === "" && type !== "str")) {
        if (formula) cells.push({ col, kind: "formula", raw: "", style, ...fx });
        continue;
      }
      const value = decodeXmlEntities(v);
      if (type === "s") {
        const index = Number.parseInt(value, 10);
        if (Number.isFinite(index)) {
          neededStrings.add(index);
          cells.push({ col, kind: "s", raw: String(index), style, ...fx });
        }
      } else if (type === "str") cells.push({ col, kind: "text", raw: value, style, ...fx });
      else if (type === "b") cells.push({ col, kind: "bool", raw: value, style, ...fx });
      else if (type === "e") cells.push({ col, kind: "error", raw: value, style, ...fx });
      else cells.push({ col, kind: "number", raw: value, style, ...fx });
    }
    rawRows.push({ number: rowNumber, cells });
  }
  if (totalCols !== null && totalCols > context.maxCols) moreCols = true;
  if (
    !moreRows &&
    totalRows !== null &&
    totalRows > rawRows.length &&
    rawRows.length >= context.maxRows
  ) {
    moreRows = true;
  }

  const strings = await readSharedStrings(context.archive, neededStrings);
  // Width follows the cells actually present: a sloppy `<dimension>` (A1:XFD1048576) must not add blank columns.
  const width = Math.min(context.maxCols, maxColSeen);

  // ---- cells by address, for formulas that need evaluating -------------------------------------------------------
  const byAddr = new Map<string, ParsedCell>();
  for (const row of rawRows)
    for (const cell of row.cells) byAddr.set(`${cell.col}:${row.number}`, cell);
  const lastRowLoaded = rawRows.length ? rawRows[rawRows.length - 1]!.number : 0;
  const memo = new Map<string, Val | FormulaError>();
  const visiting = new Set<string>();
  const valueAt = (col: number, rowNumber: number): Val => {
    if (rowNumber > lastRowLoaded && moreRows) throw new FormulaError(UNKNOWN); // past what the preview read
    if (col >= context.maxCols && moreCols) throw new FormulaError(UNKNOWN);
    const cell = byAddr.get(`${col}:${rowNumber}`);
    if (!cell) return null;
    switch (cell.kind) {
      case "number": {
        const n = Number(cell.raw);
        return Number.isFinite(n) ? n : null;
      }
      case "s":
        return strings.get(Number(cell.raw)) ?? "";
      case "text":
        return cell.raw;
      case "bool":
        return cell.raw === "1";
      case "error":
        throw new FormulaError(cell.raw);
      case "formula": {
        const key = `${col}:${rowNumber}`;
        const hit = memo.get(key);
        if (hit !== undefined) {
          if (hit instanceof FormulaError) throw hit;
          return hit;
        }
        if (visiting.has(key)) throw new FormulaError("#REF!");
        visiting.add(key);
        try {
          if (!cell.formula) throw new FormulaError(UNKNOWN);
          const result = evaluate(cell.formula, {
            cell: (ref: Ref) => {
              if (ref.sheet !== undefined && ref.sheet !== name) throw new FormulaError(UNKNOWN); // other sheets are not loaded
              return valueAt(ref.col - 1, ref.row);
            },
          });
          if (!result.ok)
            throw new FormulaError(result.error === "#NAME?" ? UNKNOWN : result.error);
          memo.set(key, result.value);
          return result.value;
        } catch (error) {
          const failure = error instanceof FormulaError ? error : new FormulaError(UNKNOWN);
          memo.set(key, failure);
          throw failure;
        } finally {
          visiting.delete(key);
        }
      }
    }
  };
  const showComputed = (cell: ParsedCell, rowNumber: number): string => {
    try {
      const value = valueAt(cell.col, rowNumber);
      if (value === null) return "";
      if (typeof value === "number")
        return formatNumber(String(value), context.styles.formatOf(cell.style), context.date1904);
      if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
      return value;
    } catch (error) {
      const code = error instanceof FormulaError ? error.code : UNKNOWN;
      return code === UNKNOWN ? (cell.formula ? `=${cell.formula}` : "") : code;
    }
  };

  const formulas: string[][] = [];
  const rows = rawRows.map((row) => {
    const out: string[] = Array.from({ length: width }, () => "");
    const fx: string[] = Array.from({ length: width }, () => "");
    for (const cell of row.cells) {
      if (cell.col >= width) continue;
      if (cell.formula) fx[cell.col] = `=${cell.formula}`;
      out[cell.col] =
        cell.kind === "formula"
          ? showComputed(cell, row.number)
          : cell.kind === "s"
            ? (strings.get(Number(cell.raw)) ?? "")
            : cell.kind === "bool"
              ? cell.raw === "1"
                ? "TRUE"
                : "FALSE"
              : cell.kind === "number"
                ? formatNumber(cell.raw, context.styles.formatOf(cell.style), context.date1904)
                : cell.raw;
    }
    formulas.push(fx);
    return out;
  });
  return {
    name,
    rows,
    rowNumbers: rawRows.map((row) => row.number),
    formulas,
    totalRows,
    totalCols,
    moreRows,
    moreCols,
  };
}
