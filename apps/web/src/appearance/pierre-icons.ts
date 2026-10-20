import { VIDEO_FILE_EXTENSIONS } from "@kora/shared/videoFiles";
import {
  type FileTreeIcons,
  getBuiltInSpriteSheet,
  createFileTreeIconResolver,
} from "@pierre/trees";

export interface FileIconResolution {
  token?: string;
  name: string;
}

const VIDEO_ICON = "kora-file-icon-video";
const AGENTS_ICON = "kora-file-icon-agents";
const PNPM_ICON = "kora-file-icon-pnpm";
const SPRITE_ELEMENT_ID = "kora-pierre-file-icon-sprite";

// Lucide "film" glyph (ISC licensed), the agents prompt mark, and the pnpm logo.
const KORA_SPRITE = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" focusable="false">`,
  `<symbol id="${VIDEO_ICON}" viewBox="0 0 24 24" fill="none" stroke="#a631be" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`,
  `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>`,
  `</symbol>`,
  `<symbol id="${AGENTS_ICON}" viewBox="0 0 32 32">`,
  `<path fill="currentColor" fill-rule="evenodd" d="M16 3a13 13 0 1 0 0 26 13 13 0 0 0 0-26Zm-5.2 7.9a1.3 1.3 0 0 1 1.8-.1l5 4.5a1.3 1.3 0 0 1 0 1.9l-5 4.5a1.3 1.3 0 1 1-1.7-1.9l3.9-3.5-3.9-3.5a1.3 1.3 0 0 1-.1-1.9Zm8.4 9.6h4.6a1.3 1.3 0 0 1 0 2.6h-4.6a1.3 1.3 0 0 1 0-2.6Z"/>`,
  `</symbol>`,
  `<symbol id="${PNPM_ICON}" viewBox="0 0 32 32">`,
  `<path fill="#f9ad00" d="M3 4h7v7H3zM12.5 4h7v7h-7zM22 4h7v7h-7zM22 13.5h7v7h-7z"/>`,
  `<path fill="currentColor" d="M3 13.5h7v7H3zM12.5 13.5h7v7h-7zM3 23h7v7H3zM12.5 23h7v7h-7zM22 23h7v7h-7z"/>`,
  `</symbol>`,
  `</svg>`,
].join("");

export const KORA_PIERRE_ICONS = {
  set: "complete",
  colored: true,
  spriteSheet: KORA_SPRITE,
  byFileName: {
    "pnpm-workspace.yaml": PNPM_ICON,
    "pnpm-lock.yaml": PNPM_ICON,
    "agents.md": AGENTS_ICON,
    "tsconfig.json": "file-tree-builtin-typescript",
    "package.json": "file-tree-builtin-npm",
  },
  byFileExtension: Object.fromEntries(VIDEO_FILE_EXTENSIONS.map((ext) => [ext, VIDEO_ICON])),
} satisfies FileTreeIcons;

const EXTENSION_BY_LANGUAGE: Record<string, string> = {
  yaml: "yml",
  tsx: "tsx",
  typescript: "ts",
  swift: "swift",
  shellscript: "sh",
  shell: "sh",
  rust: "rs",
  ruby: "rb",
  python: "py",
  plaintext: "txt",
  mdx: "mdx",
  markdown: "md",
  jsx: "jsx",
  javascript: "js",
  dockerfile: "dockerfile",
  csharp: "cs",
  bash: "sh",
};

const resolver = createFileTreeIconResolver(KORA_PIERRE_ICONS);

export function basenameOfPath(pathValue: string): string {
  return pathValue.slice(pathValue.lastIndexOf("/") + 1);
}

export function inferEntryKindFromPath(pathValue: string): "file" | "directory" {
  const fallbackBase = basenameOfPath(pathValue);
  if (fallbackBase.startsWith(".") && !fallbackBase.slice(1).includes(".")) return "directory";
  return fallbackBase.includes(".") ? "file" : "directory";
}

export function syntheticFileNameForLanguageId(languageId: string): string {
  const ident = languageId.toLowerCase();
  return `file.${EXTENSION_BY_LANGUAGE[ident] ?? ident}`;
}

export function resolveFileIconForEntry(
  pathValue: string,
  variant: "file" | "directory",
): FileIconResolution | null {
  if (variant === "directory") return null;
  return resolver.resolveIcon("file-tree-icon-file", pathValue) as FileIconResolution;
}

export function hasSpecificFileIconForFileName(baseName: string): boolean {
  return resolveFileIconForEntry(baseName, "file")?.token !== "default";
}

export function ensureFileIconSprite(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(SPRITE_ELEMENT_ID)) return;
  const hostInfo = document.createElement("div");
  hostInfo.id = SPRITE_ELEMENT_ID;
  hostInfo.setAttribute("aria-hidden", "true");
  Object.assign(hostInfo.style, {
    position: "absolute",
    width: "0",
    height: "0",
    overflow: "hidden",
    pointerEvents: "none",
  });
  hostInfo.innerHTML = getBuiltInSpriteSheet("complete") + KORA_SPRITE;
  document.body.prepend(hostInfo);
}
