// Preview state machines for one blob file: a spreadsheet (open once, read sheets on demand), a document / deck / PDF
// summary, and a blob: URL for an image or a PDF frame. Every failure becomes a `PreviewError`-coded state the card
// words plainly; nothing throws into React.

import { resolvePrimaryHostHttpUrl } from "~/hosts/primary/target";
import { fetchPrimaryHost } from "~/hosts/primary/shellAuth";
import type { SheetData } from "./xlsx";
import { runPreview } from "./previewClient";
import type { OfficeMeta } from "./officeMeta";
import { type PreviewErrorCode, PREVIEW_LIMITS, PreviewError } from "./limits";
import { fetchBlobFileBytes } from "./blobFileBytes";
import { useCallback, useEffect, useState, useRef } from "react";

export interface PreviewFailure {
  readonly code: PreviewErrorCode;
  readonly message: string;
}

function failureOf(error: unknown): PreviewFailure {
  if (error instanceof PreviewError) return { code: error.code, message: error.message };
  return { code: "unavailable", message: "This file could not be previewed." };
}

export type SheetPreviewState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly failure: PreviewFailure }
  | {
      readonly status: "ready";
      readonly sheetNames: ReadonlyArray<string>;
      readonly active: number;
      readonly sheet: SheetData | null;
      readonly sheetLoading: boolean;
      readonly sheetError: PreviewFailure | null;
      readonly byteLength: number;
    };

export function useSheetPreview(input: {
  readonly blobId: string;
  readonly relativePath: string;
  readonly enabled: boolean;
}): { state: SheetPreviewState; selectSheet: (index: number) => void } {
  // Always the capped read: the chat card shows the top of it, the expanded view all of it, with no reload between.
  const rows = PREVIEW_LIMITS.sheetRows;
  const cols = PREVIEW_LIMITS.sheetCols;
  const { blobId, relativePath, enabled } = input;
  const [state, setState] = useState<SheetPreviewState>({ status: "idle" });
  const keyRef = useRef<string | null>(null);
  const cache = useRef(new Map<string, SheetData>());
  const activeRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const key = `${blobId}:${relativePath}:${Math.random().toString(36).slice(2)}`;
    keyRef.current = key;
    cache.current.clear();
    activeRef.current = 0;
    setState({ status: "loading" });
    void (async () => {
      try {
        const bytes = await fetchBlobFileBytes({
          blobId,
          relativePath,
          maxBytes: PREVIEW_LIMITS.maxOfficeBytes,
        });
        const byteLength = bytes.byteLength;
        const opened = await runPreview({
          op: "open-sheet",
          key,
          bytes: bytes.buffer as ArrayBuffer,
        });
        if (cancelled) return;
        if (!opened.ok) throw new PreviewError(opened.code, opened.message);
        if (!("sheetNames" in opened))
          throw new PreviewError("corrupt", "Unexpected preview answer.");
        setState({
          status: "ready",
          sheetNames: opened.sheetNames,
          active: 0,
          sheet: null,
          sheetLoading: true,
          sheetError: null,
          byteLength,
        });
        const first = await runPreview({ op: "read-sheet", key, index: 0, rows, cols });
        if (cancelled) return;
        setState((current) =>
          current.status !== "ready"
            ? current
            : first.ok && "sheet" in first
              ? (cache.current.set(`0:${rows}`, first.sheet),
                { ...current, sheet: first.sheet, sheetLoading: false })
              : {
                  ...current,
                  sheetLoading: false,
                  sheetError: first.ok
                    ? { code: "corrupt", message: "Unexpected preview answer." }
                    : { code: first.code, message: first.message },
                },
        );
      } catch (error) {
        if (!cancelled) setState({ status: "error", failure: failureOf(error) });
      }
    })();
    return () => {
      cancelled = true;
      void runPreview({ op: "close", key });
    };
  }, [blobId, relativePath, enabled, rows, cols]);

  const selectSheet = useCallback(
    (index: number) => {
      const key = keyRef.current;
      if (key === null) return;
      activeRef.current = index;
      const cached = cache.current.get(`${index}:${rows}`);
      setState((current) =>
        current.status !== "ready"
          ? current
          : {
              ...current,
              active: index,
              sheet: cached ?? null,
              sheetLoading: !cached,
              sheetError: null,
            },
      );
      if (cached) return;
      void runPreview({ op: "read-sheet", key, index, rows, cols }).then((answer) => {
        if (activeRef.current !== index) return;
        if (answer.ok && "sheet" in answer) cache.current.set(`${index}:${rows}`, answer.sheet);
        setState((current) =>
          current.status !== "ready" || current.active !== index
            ? current
            : answer.ok && "sheet" in answer
              ? { ...current, sheet: answer.sheet, sheetLoading: false, sheetError: null }
              : {
                  ...current,
                  sheetLoading: false,
                  sheetError: answer.ok
                    ? { code: "corrupt", message: "Unexpected preview answer." }
                    : { code: answer.code, message: answer.message },
                },
        );
      });
    },
    [rows, cols],
  );

  return { state, selectSheet };
}

export type OfficeMetaState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "ready"; readonly meta: OfficeMeta; readonly byteLength: number }
  | { readonly status: "error"; readonly failure: PreviewFailure };

export function useOfficeMeta(input: {
  readonly blobId: string;
  readonly relativePath: string;
  readonly family: "document" | "slides" | "pdf";
  readonly enabled: boolean;
}): OfficeMetaState {
  const { blobId, relativePath, family, enabled } = input;
  const [state, setState] = useState<OfficeMetaState>({ status: "idle" });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const bytes = await fetchBlobFileBytes({
          blobId,
          relativePath,
          maxBytes: PREVIEW_LIMITS.maxOfficeBytes,
        });
        const byteLength = bytes.byteLength; // the buffer is transferred to the worker below
        const answer = await runPreview({
          op: "office-meta",
          family,
          bytes: bytes.buffer as ArrayBuffer,
        });
        if (cancelled) return;
        if (!answer.ok) throw new PreviewError(answer.code, answer.message);
        if (!("meta" in answer)) throw new PreviewError("corrupt", "Unexpected preview answer.");
        setState({ status: "ready", meta: answer.meta, byteLength });
      } catch (error) {
        if (!cancelled) setState({ status: "error", failure: failureOf(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blobId, relativePath, family, enabled]);
  return state;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  ...Object.fromEntries([
    ["ico", "image/x-icon"],
    ["svg", "image/svg+xml"],
    ["avif", "image/avif"],
    ["webp", "image/webp"],
    ["jpg", "image/jpeg"],
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
  ]),
};

export type ObjectUrlState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "ready"; readonly url: string; readonly byteLength: number }
  | { readonly status: "error"; readonly failure: PreviewFailure };

/** A blob: URL for an image or PDF (revoked on unmount), for `<img>` / `<object>`. */
export function useFileObjectUrl(input: {
  readonly blobId: string;
  readonly relativePath: string;
  readonly enabled: boolean;
  readonly maxBytes: number;
}): ObjectUrlState {
  const { blobId, relativePath, enabled, maxBytes } = input;
  const [state, setState] = useState<ObjectUrlState>({ status: "idle" });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let url: string | null = null;
    setState({ status: "loading" });
    void fetchBlobFileBytes({ blobId, relativePath, maxBytes })
      .then((bytes) => {
        if (cancelled) return;
        const extension = relativePath.split(".").at(-1)?.toLowerCase() ?? "";
        const blob = new Blob([bytes.buffer as ArrayBuffer], {
          type: MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
        });
        url = URL.createObjectURL(blob);
        setState({ status: "ready", url, byteLength: bytes.byteLength });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", failure: failureOf(error) });
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [blobId, relativePath, enabled, maxBytes]);
  return state;
}

export type ThumbnailState =
  | { readonly status: "idle" | "loading" | "unavailable" }
  | { readonly status: "ready"; readonly url: string };

function blobThumbnailUrl(blobId: string, relativePath: string): string {
  return resolvePrimaryHostHttpUrl(`/api/blobs/${encodeURIComponent(blobId)}/thumbnail`, {
    path: relativePath,
  });
}

/**
 * The first page of a Word document / deck as an image, made by the daemon (ui-server blobThumbs.ts). Any failure -
 * an older daemon, another OS, a renderer that gave up - is just `unavailable`: the card keeps its text excerpt.
 */
export function useFileThumbnail(input: {
  readonly blobId: string;
  readonly relativePath: string;
  readonly enabled: boolean;
}): ThumbnailState {
  const { blobId, relativePath, enabled } = input;
  const [state, setState] = useState<ThumbnailState>({ status: "idle" });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let url: string | null = null;
    const controller = new AbortController();
    setState({ status: "loading" });
    void fetchPrimaryHost(blobThumbnailUrl(blobId, relativePath), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`thumbnail ${response.status}`);
        const blob = await response.blob();
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([blob], { type: "image/png" }));
        setState({ status: "ready", url });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "unavailable" });
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [blobId, relativePath, enabled]);
  return state;
}
