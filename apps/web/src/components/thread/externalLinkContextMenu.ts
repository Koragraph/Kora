import type { ContextMenuItem } from "@kora/contracts";

export type ExternalLinkContextMenuAction =
  | "unlink-from-thread"
  | "open-in-preview"
  | "link-to-thread"
  | "open-external"
  | "copy-link";

export type ExternalLinkContextMenuFailureOperation =
  | "copy-link"
  | "open-link-external"
  | "open-link-in-preview"
  | "show-link-context-menu"
  | "link-pull-request-to-thread"
  | "unlink-pull-request-from-thread";

/** Hostname of an http(s) link (protocol-relative links count as https), else null. */
export function resolveExternalWebLinkHost(href: string | undefined): string | null {
  if (!href) return null;
  let parsed: URL;
  try {
    parsed = new URL(href.startsWith("//") ? "https:" + href : href);
  } catch {
    return null;
  }
  const isWeb = parsed.protocol === "https:" || parsed.protocol === "http:";
  return isWeb && parsed.hostname !== "" ? parsed.hostname : null;
}

const FAILURE_OPERATION: Record<
  ExternalLinkContextMenuAction,
  ExternalLinkContextMenuFailureOperation
> = {
  "unlink-from-thread": "unlink-pull-request-from-thread",
  "link-to-thread": "link-pull-request-to-thread",
  "copy-link": "copy-link",
  "open-external": "open-link-external",
  "open-in-preview": "open-link-in-preview",
};

export async function showExternalLinkContextMenu(options: {
  href: string;
  position: { x: number; y: number };
  canOpenInPreview?: boolean;
  threadLinkAction?: "link-to-thread" | "unlink-from-thread" | undefined;
  showContextMenu: (
    items: readonly ContextMenuItem<ExternalLinkContextMenuAction>[],
    position: { x: number; y: number },
  ) => Promise<ExternalLinkContextMenuAction | null>;
  openInPreview: (href: string) => Promise<void>;
  openExternal: (href: string) => Promise<void>;
  copyLink: (href: string) => Promise<unknown>;
  updateThreadLink?: (href: string, linked: boolean) => Promise<void>;
  reportFailure: (operation: ExternalLinkContextMenuFailureOperation, cause: unknown) => void;
}): Promise<void> {
  const { href, position, reportFailure } = options;

  const items: ContextMenuItem<ExternalLinkContextMenuAction>[] = [];
  if (options.threadLinkAction) {
    items.push({
      id: options.threadLinkAction,
      label: options.threadLinkAction === "link-to-thread" ? "Link to chat" : "Unlink from chat",
    });
  }
  if (options.canOpenInPreview !== false) {
    items.push({ id: "open-in-preview", label: "Open in integrated browser" });
  }
  items.push(
    { id: "open-external", label: "Open in system browser" },
    { id: "copy-link", label: "Copy Link" },
  );

  let choice: ExternalLinkContextMenuAction | null;
  try {
    choice = await options.showContextMenu(items, position);
  } catch (cause) {
    reportFailure("show-link-context-menu", cause);
    return;
  }
  if (choice === null) return;

  try {
    switch (choice) {
      case "open-in-preview":
        await options.openInPreview(href);
        break;
      case "open-external":
        await options.openExternal(href);
        break;
      case "copy-link":
        await options.copyLink(href);
        break;
      case "link-to-thread":
      case "unlink-from-thread":
        await options.updateThreadLink?.(href, choice === "link-to-thread");
        break;
    }
  } catch (cause) {
    reportFailure(FAILURE_OPERATION[choice], cause);
  }
}
