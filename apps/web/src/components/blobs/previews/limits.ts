// Limits for rich previews. A preview is a convenience, never a gate: past a limit the card says so plainly and the
// file is still one click from the native app. Nothing here truncates silently.
export const PREVIEW_LIMITS = {
  /** Largest spreadsheet / document / deck / PDF we download to preview (the card still offers Open). */
  maxOfficeBytes: 25 * 1024 * 1024,
  /** Largest image shown inline. */
  maxImageBytes: 20 * 1024 * 1024,
  /** Largest uncompressed XML part we will inflate (zip-bomb guard). */
  maxPartBytes: 64 * 1024 * 1024,
  /** Spreadsheet rows / columns rendered per sheet (the full table is what Open is for). */
  sheetRows: 200,
  sheetCols: 40,
  /** Rows / columns shown in the collapsed chat card. */
  cardRows: 6,
  cardCols: 8,
  /** Largest delimited text we parse (also `projects.readFile`'s own read cap). */
  maxDelimitedBytes: 512 * 1024,
  delimitedRows: 200,
  delimitedCols: 40,
  /** Sheets listed as tabs. */
  maxSheets: 30,
} as const;

export type PreviewErrorCode =
  | "too_large"
  | "unsupported"
  | "corrupt"
  | "unavailable"
  | "not_found";

export class PreviewError extends Error {
  readonly code: PreviewErrorCode;
  constructor(code: PreviewErrorCode, message: string) {
    super(message);
    this.name = "PreviewError";
    this.code = code;
  }
}

export function formatBytes(byteLength: number): string {
  if (!Number.isFinite(byteLength) || byteLength < 0) return "0 B";
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(byteLength / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

export function tooLargeMessage(byteLength: number, limit: number, what: string): string {
  return `This ${what} is ${formatBytes(byteLength)}, over the ${formatBytes(limit)} preview limit. Open it to see everything.`;
}
