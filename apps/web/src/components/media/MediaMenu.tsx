import { downloadMedia, readMediaPng } from "./mediaKinds";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { threadToast, toastManager } from "../ui/toast";
import { readLocalApi } from "../../localApi";
import { writeTextToClipboard } from "../../hooks/useCopyText";
import { mediaReferenceFileName, type MediaReference } from "@kora/client-runtime/media/reference";
import type { MediaActionId } from "@kora/client-runtime/media/actions";
import { type ReactElement, type MouseEvent, useState, useRef } from "react";

export interface MediaActionSource {
  readonly reference?: MediaReference;
  readonly onOpenFile?: () => void;
  readonly kind: "image" | "video";
  readonly src: string | null;
  readonly name: string;
}

interface MenuEntry {
  readonly id: MediaActionId;
  readonly label: string;
  readonly disabled?: boolean;
}

function canWriteImageToClipboard(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function" &&
    typeof ClipboardItem !== "undefined"
  );
}

function buildMenu(source: MediaActionSource): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const reference = source.reference;
  if (reference?.kind === "file") {
    entries.push({ id: "copy-full-path", label: "Copy full path" });
    if (reference.relativePath)
      entries.push({ id: "copy-relative-path", label: "Copy relative path" });
  } else if (reference?.kind === "url") {
    entries.push({ id: "copy-url", label: "Copy URL" });
  }
  if (source.onOpenFile) entries.push({ id: "open-file", label: "Open in file viewer" });
  entries.push({
    id: "save",
    label: source.kind === "image" ? "Save image" : "Save video",
    disabled: source.src === null,
  });
  if (source.kind === "image") {
    entries.push({
      id: "copy-image",
      label: "Copy image",
      disabled: source.src === null || !canWriteImageToClipboard(),
    });
  }
  return entries;
}

function tooltipTextFor(source: MediaActionSource): string {
  const reference = source.reference;
  if (reference?.kind === "file") return reference.path;
  if (reference?.kind === "url") return reference.url;
  return source.name;
}

/**
 * Adds a source tooltip and a right-click menu (copy / open / save) to an existing media element without
 * wrapping it in any layout element.
 */
export function MediaActions(props: { source: MediaActionSource; children: ReactElement }) {
  const { source } = props;
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const menuOpen = useRef(false);

  const runAction = async (entry: MenuEntry): Promise<void> => {
    const reference = source.reference;
    switch (entry.id) {
      case "copy-full-path":
        if (reference?.kind === "file") await writeTextToClipboard(reference.path, "file path");
        toastManager.add({ type: "success", title: "Path copied" });
        return;
      case "copy-relative-path":
        if (reference?.kind === "file" && reference.relativePath) {
          await writeTextToClipboard(reference.relativePath, "file path");
        }
        toastManager.add({ type: "success", title: "Path copied" });
        return;
      case "copy-url":
        if (reference?.kind === "url") await writeTextToClipboard(reference.url, "URL");
        toastManager.add({ type: "success", title: "URL copied" });
        return;
      case "open-file":
        source.onOpenFile?.();
        return;
      case "save":
      case "copy-image":
        return;
    }
  };

  const runMediaAction = async (entry: MenuEntry, progressId: { current: string | null }) => {
    const src = source.src;
    if (entry.id === "save") {
      if (!src) throw new Error("This media is unavailable. Try reopening the preview.");
      progressId.current = toastManager.add({
        type: "loading",
        title: source.kind === "image" ? "Preparing image download…" : "Preparing video download…",
      });
      const fileName =
        (source.reference ? mediaReferenceFileName(source.reference) : undefined) ||
        source.name ||
        source.kind;
      await downloadMedia(src, fileName);
      toastManager.update(progressId.current, { type: "success", title: "Download started" });
      return;
    }
    // copy-image
    if (!src) throw new Error("This media is unavailable. Try reopening the preview.");
    if (!canWriteImageToClipboard()) {
      throw new Error(
        "Image copying is unavailable. Use a secure browser connection or save the image.",
      );
    }
    // The write must start inside the user gesture, so the blob is handed over as a promise.
    const write = navigator.clipboard.write([
      new ClipboardItem({ "image/png": readMediaPng(src) }),
    ]);
    progressId.current = toastManager.add({ type: "loading", title: "Copying image…" });
    await write;
    toastManager.update(progressId.current, { type: "success", title: "Image copied" });
  };

  const onContextMenu = async (event: MouseEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    const api = readLocalApi();
    if (!api || menuOpen.current) return;
    event.preventDefault();
    event.stopPropagation();
    menuOpen.current = true;
    setTooltipOpen(false);

    const rect = event.currentTarget.getBoundingClientRect();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    const position = fromKeyboard
      ? { x: rect.left, y: rect.bottom }
      : { x: event.clientX, y: event.clientY };

    const progress: { current: string | null } = { current: null };
    let chosen: MenuEntry | null = null;
    try {
      const entries = buildMenu(source);
      const id = await api.contextMenu.show(
        entries.map((entry) => ({
          id: entry.id,
          label: entry.label,
          ...(entry.disabled !== undefined ? { disabled: entry.disabled } : {}),
        })),
        position,
      );
      chosen = entries.find((entry) => entry.id === id) ?? null;
      if (!chosen) return;
      if (chosen.id === "save" || chosen.id === "copy-image")
        await runMediaAction(chosen, progress);
      else await runAction(chosen);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The media action failed.";
      const title = chosen
        ? `Could not ${chosen.label.toLowerCase()}`
        : progress.current === null && chosen === null
          ? "Could not open media menu"
          : "Could not complete media action";
      const toast = threadToast({
        type: "error",
        title,
        description: message || "The media action failed.",
      });
      if (progress.current !== null) toastManager.update(progress.current, toast);
      else toastManager.add(toast);
    } finally {
      menuOpen.current = false;
    }
  };

  return (
    <Tooltip open={tooltipOpen} onOpenChange={(open) => setTooltipOpen(open && !menuOpen.current)}>
      <TooltipTrigger
        render={props.children}
        tabIndex={0}
        onContextMenu={(event: MouseEvent<HTMLElement>) => void onContextMenu(event)}
      />
      <TooltipPopup className="max-w-[min(40rem,calc(100vw-2rem))] break-all font-mono text-[11px] leading-tight">
        {tooltipTextFor(source)}
      </TooltipPopup>
    </Tooltip>
  );
}
