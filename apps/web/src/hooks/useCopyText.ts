import { useCallback, useEffect, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import {
  CONTEXT_CHIP_CLIPBOARD_MIME,
  encodeContextChipClipboardHtml,
} from "@kora/shared/contextChipClipboard";

export class ClipboardApiUnavailableError extends Schema.TaggedError<ClipboardApiUnavailableError>()(
  "ClipboardApiUnavailableError",
  { target: Schema.String },
) {
  override get message() {
    const detail = `Clipboard API is unavailable while copying ${this.target}.`;
    return detail;
  }
}

export class ClipboardWriteError extends Schema.TaggedError<ClipboardWriteError>()(
  "ClipboardWriteError",
  { target: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    const detail = `Failed to copy ${this.target} to the clipboard.`;
    return detail;
  }
}

export class ClipboardReadUnavailableError extends Schema.TaggedError<ClipboardReadUnavailableError>()(
  "ClipboardReadUnavailableError",
  { target: Schema.String },
) {
  override get message() {
    const detail = `Clipboard API is unavailable while reading ${this.target}.`;
    return detail;
  }
}

export class ClipboardReadError extends Schema.TaggedError<ClipboardReadError>()(
  "ClipboardReadError",
  { target: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Failed to read ${this.target} from the clipboard.`;
  }
}

type Flavors = Readonly<Record<string, string>>;

/**
 * Copy through a throwaway textarea for pages where navigator.clipboard is missing
 * (plain HTTP). Must run synchronously inside the user gesture.
 */
function copyWithSelection(val: string, flavors: Flavors): boolean {
  if (typeof document === "undefined") return false;
  const prior = document.activeElement as HTMLElement | null;
  const area = document.createElement("textarea");
  area.value = val;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  Object.assign(area.style, {
    position: "fixed",
    top: "0",
    left: "-9999px",
    opacity: "0",
    fontSize: "16px", // 16px stops iOS from zooming on focus
  });
  const hasExtras = Object.keys(flavors).length > 0;
  const onCopy = (evt: ClipboardEvent) => {
    if (!hasExtras || !evt.clipboardData) return;
    evt.clipboardData.setData("text/plain", val);
    for (const [type, data] of Object.entries(flavors)) evt.clipboardData.setData(type, data);
    evt.preventDefault();
  };
  area.addEventListener("copy", onCopy as EventListener);
  document.body.appendChild(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, val.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.removeEventListener("copy", onCopy as EventListener);
    area.remove();
    prior?.focus?.();
  }
}

function withoutPlainText(more: Flavors | undefined): Record<string, string> {
  const acc: Record<string, string> = {};
  for (const [type, data] of Object.entries(more ?? {})) {
    if (type !== "text/plain") acc[type] = data;
  }
  return acc;
}

const blobOf = (typ: string, blob: string) => new Blob([blob], { type: typ });

export async function writeTextToClipboard(
  val: string,
  dest = "text",
  extraFlavors?: Flavors,
): Promise<boolean> {
  if (typeof window === "undefined") throw new ClipboardApiUnavailableError({ target: dest });
  if (val.length === 0) return false;

  const flavors = withoutPlainText(extraFlavors);
  const fragment = flavors[CONTEXT_CHIP_CLIPBOARD_MIME];
  if (fragment !== undefined) {
    flavors["text/html"] = encodeContextChipClipboardHtml(val, fragment, flavors["text/html"]);
  }

  const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (typeof clip?.writeText !== "function") {
    if (copyWithSelection(val, flavors)) return true;
    throw new ClipboardApiUnavailableError({ target: dest });
  }

  if (
    Object.keys(flavors).length > 0 &&
    typeof ClipboardItem !== "undefined" &&
    typeof clip.write === "function"
  ) {
    const attempt = (more: Flavors) =>
      clip.write([
        new ClipboardItem({
          "text/plain": blobOf("text/plain", val),
          ...Object.fromEntries(Object.entries(more).map(([t, d]) => [t, blobOf(t, d)])),
        }),
      ]);
    try {
      await attempt(flavors);
      return true;
    } catch {
      // Safari and native bridges can refuse custom types; retry with the standard pair.
      try {
        await attempt(flavors["text/html"] ? { "text/html": flavors["text/html"] } : {});
        return true;
      } catch {
        /* fall through to plain text */
      }
    }
  }

  try {
    await clip.writeText(val);
    return true;
  } catch (reason) {
    throw new ClipboardWriteError({ target: dest, cause: reason });
  }
}

export async function readTextFromClipboard(dest = "text"): Promise<string> {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    typeof navigator.clipboard?.readText !== "function"
  ) {
    throw new ClipboardReadUnavailableError({ target: dest });
  }
  try {
    return await navigator.clipboard.readText();
  } catch (reason) {
    throw new ClipboardReadError({ target: dest, cause: reason });
  }
}

export function useCopyToClipboard<TContext = void>(opts?: {
  timeout?: number;
  target?: string;
  onCopy?: (cx: TContext) => void;
  onError?: (err: Error, cx: TContext) => void;
  extraFlavors?: Flavors;
}): { copyToClipboard: (val: string, cx: TContext) => void; isCopied: boolean } {
  const [isCopied, setIsCopied] = useState(false);
  const tmr = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(opts);
  latest.current = opts;

  useEffect(
    () => () => {
      if (tmr.current) clearTimeout(tmr.current);
    },
    [],
  );

  const copyToClipboard = useCallback((val: string, cx: TContext) => {
    const { target = "text", extraFlavors } = latest.current ?? {};
    writeTextToClipboard(val, target, extraFlavors).then(
      (wrote) => {
        if (!wrote) return;
        const { timeout = 2000, onCopy } = latest.current ?? {};
        if (tmr.current) clearTimeout(tmr.current);
        setIsCopied(true);
        onCopy?.(cx);
        if (timeout !== 0) {
          tmr.current = setTimeout(() => {
            setIsCopied(false);
            tmr.current = null;
          }, timeout);
        }
      },
      (err: Error) => {
        console.error(err);
        latest.current?.onError?.(err, cx);
      },
    );
  }, []);

  return { copyToClipboard, isCopied };
}
