/**
 * Packages the desktop main-process bundle must NOT inline: native addons and the wrappers that dlopen them by real
 * path. `apps/desktop/vite.config.ts` keeps them external, and scripts/package-app.sh reads the quoted entries of
 * this list (one per line) to install exactly these as real node_modules next to the bundle. Everything else ships
 * inside `dist-electron/*.cjs`. Entries are matched as prefixes so platform-specific siblings are covered.
 */
const DESKTOP_RUNTIME_EXTERNAL_PREFIXES = [
  // Native addons and the wrappers that dlopen them by real path.
  "@crowecawcaw/xa11y",
  "ffi-rs",
  "@yuuang/",
] as const;

export function isDesktopRuntimeExternalDependency(id: string): boolean {
  return DESKTOP_RUNTIME_EXTERNAL_PREFIXES.some((prefix) => id.startsWith(prefix));
}
