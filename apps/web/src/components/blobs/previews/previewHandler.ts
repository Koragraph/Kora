// The preview engine's request handler: pure (bytes in, plain data out) so it runs identically in the worker, on the
// main thread (tests, browsers without module workers) and under Node. Workbooks stay open between requests so
// switching sheet tabs does not re-read the file.
import { PREVIEW_LIMITS, PreviewError, type PreviewErrorCode } from "./limits";
import { readDocxMeta, readPdfMeta, readPptxMeta, type OfficeMeta } from "./officeMeta";
import { openWorkbook, type SheetData, type Workbook } from "./xlsx";

export type PreviewRequest =
  | { readonly op: "open-sheet"; readonly key: string; readonly bytes: ArrayBuffer }
  | {
      readonly op: "read-sheet";
      readonly key: string;
      readonly index: number;
      readonly rows?: number;
      readonly cols?: number;
    }
  | {
      readonly op: "office-meta";
      readonly family: "document" | "slides" | "pdf";
      readonly bytes: ArrayBuffer;
    }
  | { readonly op: "close"; readonly key: string };

export type PreviewResult =
  | { readonly ok: true; readonly sheetNames: ReadonlyArray<string> }
  | { readonly ok: true; readonly sheet: SheetData }
  | { readonly ok: true; readonly meta: OfficeMeta }
  | { readonly ok: true }
  | { readonly ok: false; readonly code: PreviewErrorCode; readonly message: string };

const MAX_OPEN_WORKBOOKS = 3;

export function createPreviewHandler() {
  const open = new Map<string, Workbook>();
  return async function handle(request: PreviewRequest): Promise<PreviewResult> {
    try {
      switch (request.op) {
        case "open-sheet": {
          if (request.bytes.byteLength > PREVIEW_LIMITS.maxOfficeBytes) {
            throw new PreviewError("too_large", "This workbook is too large to preview.");
          }
          const workbook = await openWorkbook(new Uint8Array(request.bytes));
          open.delete(request.key);
          open.set(request.key, workbook);
          while (open.size > MAX_OPEN_WORKBOOKS) {
            const oldest = open.keys().next().value;
            if (oldest === undefined) break;
            open.delete(oldest);
          }
          return { ok: true, sheetNames: workbook.sheets.map((sheet) => sheet.name) };
        }
        case "read-sheet": {
          const workbook = open.get(request.key);
          if (!workbook)
            throw new PreviewError("unavailable", "The workbook was closed. Reopen the preview.");
          const sheet = await workbook.readSheet(request.index, {
            ...(request.rows !== undefined ? { rows: request.rows } : {}),
            ...(request.cols !== undefined ? { cols: request.cols } : {}),
          });
          return { ok: true, sheet };
        }
        case "office-meta": {
          if (request.bytes.byteLength > PREVIEW_LIMITS.maxOfficeBytes) {
            throw new PreviewError("too_large", "This file is too large to read its details.");
          }
          const bytes = new Uint8Array(request.bytes);
          const meta =
            request.family === "document"
              ? await readDocxMeta(bytes)
              : request.family === "slides"
                ? await readPptxMeta(bytes)
                : readPdfMeta(bytes);
          return { ok: true, meta };
        }
        case "close":
          open.delete(request.key);
          return { ok: true };
      }
    } catch (error) {
      if (error instanceof PreviewError)
        return { ok: false, code: error.code, message: error.message };
      return { ok: false, code: "corrupt", message: "This file could not be read for a preview." };
    }
  };
}
