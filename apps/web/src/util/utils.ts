import { twMerge } from "tailwind-merge";
import * as Encoding from "effect/Encoding";
import { type CxOptions, cx } from "class-variance-authority";
import { ItemId, ProjectId, ThreadId } from "@kora/contracts";

import { DraftId } from "../stores/promptDraftStore";

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export function isMacPlatform(hostOs: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(hostOs);
}

export function isWindowsPlatform(hostOs: string): boolean {
  return /^win(dows)?/i.test(hostOs);
}

export function normalizeSearchText(val: string): string {
  return val.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

const navigatorPlatform = (): string =>
  typeof navigator === "undefined" ? "" : navigator.platform;

/** How copy names the machine Kora runs on (local-only: the daemon is on the same machine as this client). */
export function thisComputer(hostOs: string = navigatorPlatform()): string {
  if (isMacPlatform(hostOs)) return "this Mac";
  return isWindowsPlatform(hostOs) ? "this PC" : "this computer";
}

/** "your Mac" / "your PC" / "your computer". */
export function yourComputer(hostOs: string = navigatorPlatform()): string {
  return thisComputer(hostOs).replace(/^this /, "your ");
}

/** Where copy tells the user to type a command: "Terminal" on a Mac, "PowerShell" on Windows. */
export function terminalAppName(hostOs: string = navigatorPlatform()): string {
  if (isMacPlatform(hostOs)) return "Terminal";
  return isWindowsPlatform(hostOs) ? "PowerShell" : "a terminal";
}

/** An example absolute folder for placeholders and hints. */
export function exampleProjectPath(hostOs: string = navigatorPlatform()): string {
  return isWindowsPlatform(hostOs) ? "C:\\Users\\you\\Projects\\app" : "/Users/you/Projects/app";
}

/** What to do when Kora may not read a project folder (permission denied), in this OS's own words. */
export function folderAccessHint(hostOs: string = navigatorPlatform()): string {
  if (isMacPlatform(hostOs))
    return "Give your user access in Finder → Get Info → Sharing & Permissions; for a folder in Desktop, Documents or Downloads, allow Kora in System Settings → Privacy & Security → Files and Folders (or Full Disk Access).";
  if (isWindowsPlatform(hostOs))
    return "Give your user access in File Explorer: right-click the folder → Properties → Security.";
  return "Give your user read access to the folder.";
}

/** How to go to a copied path in the file manager: Finder's Go to Folder, Explorer's address bar. */
export function pastePathHint(hostOs: string = navigatorPlatform()): string {
  if (isMacPlatform(hostOs)) return "Paste it in Finder with Cmd+Shift+G.";
  if (isWindowsPlatform(hostOs)) return "Paste it in File Explorer's address bar (Ctrl+L).";
  return "Paste it in your file manager's location bar.";
}

export function getLocalFileManagerName(hostOs: string): string {
  if (isMacPlatform(hostOs)) return "Finder";
  return isWindowsPlatform(hostOs) ? "File Explorer" : "Files";
}

export function randomUUID(): string {
  const buf = globalThis.crypto.getRandomValues(new Uint8Array(16));
  buf[6] = (buf[6]! & 0x0f) | 0x40;
  buf[8] = (buf[8]! & 0x3f) | 0x80;
  const hex = Encoding.encodeHex(buf);
  const groups = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ];
  return groups.join("-");
}

const mintId = (): string => randomUUID();

export const newDraftId = (): DraftId => DraftId.make(mintId());

export const newThreadId = (): ThreadId => ThreadId.make(mintId());

export const newProjectId = (): ProjectId => ProjectId.make(mintId());

export const newMessageId = (): ItemId => ItemId.make(randomUUID());
