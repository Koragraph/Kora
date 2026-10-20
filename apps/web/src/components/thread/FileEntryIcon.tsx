import { cn } from "~/util/utils";
import { resolveFileIconForEntry, ensureFileIconSprite } from "~/appearance/pierre-icons";
import { useInsertionEffect, useMemo, memo } from "react";
import { FolderIcon, FileIcon } from "lucide-react";

// [light, dark] per file-type token, written as one row per color pair.
type ColorPair = readonly [light: string, dark: string];

const TOKENS_BY_COLOR: ReadonlyArray<readonly [ColorPair, ReadonlyArray<string>]> = [
  [
    ["#1a85d4", "#69b1ff"],
    ["biome", "c", "cpp", "docker", "python", "typescript", "vscode", "webpack"],
  ],
  [
    ["#d47628", "#ffa359"],
    ["claude", "html", "json", "rust", "svg", "swift", "zig", "zip"],
  ],
  [
    ["#693acf", "#9d6afb"],
    ["bootstrap", "css", "eslint", "terraform", "wasm"],
  ],
  [
    ["#d52c36", "#ff6762"],
    ["npm", "postcss", "ruby", "svelte", "yml"],
  ],
  [
    ["#199f43", "#5ecc71"],
    ["bash", "markdown", "svgo", "vue"],
  ],
  [
    ["#84848a", "#adadb1"],
    ["default", "nextjs", "stylelint", "text"],
  ],
  [
    ["#1ca1c7", "#68cdf2"],
    ["go", "oxc", "react", "tailwind"],
  ],
  [
    ["#a631be", "#d568ea"],
    ["astro", "database", "vite"],
  ],
  [
    ["#d5a910", "#ffd452"],
    ["babel", "browserslist", "javascript"],
  ],
  [
    ["#d32a61", "#ff678d"],
    ["graphql", "image", "sass"],
  ],
  [
    ["#17a5af", "#64d1db"],
    ["mcp", "prettier", "table"],
  ],
  [["#594c5b", "#79697b"], ["bun"]],
  [["#ff8c5b", "#d5512f"], ["git"]],
];

const TOKEN_COLORS: Readonly<Record<string, ColorPair>> = Object.fromEntries(
  TOKENS_BY_COLOR.flatMap(([pair, tokens]) => tokens.map((token) => [token, pair] as const)),
);

function colorForToken(token: string | undefined, theme: "light" | "dark"): string {
  const pair = (token && TOKEN_COLORS[token]) || TOKEN_COLORS.default!;
  return pair[theme === "dark" ? 1 : 0];
}

export const FileEntryIcon = memo(function FileEntryIcon({
  pathValue,
  kind,
  theme,
  className,
}: {
  kind: "directory" | "file";
  theme: "light" | "dark";
  className?: string;
  pathValue: string;
}) {
  useInsertionEffect(() => {
    ensureFileIconSprite();
  }, []);

  const icon = useMemo(() => resolveFileIconForEntry(pathValue, kind), [pathValue, kind]);

  if (!icon) {
    const Fallback = kind === "directory" ? FolderIcon : FileIcon;
    return <Fallback className={cn("size-4 text-icon-muted", className)} />;
  }

  return (
    <svg
      aria-hidden="true"
      className={cn("size-4 shrink-0", className)}
      data-icon-token={icon.token}
      data-pierre-icon={icon.name}
      style={{ color: colorForToken(icon.token, theme) }}
      viewBox="0 0 16 16"
    >
      <use href={`#${icon.name}`} />
    </svg>
  );
});
