/**
 * Dependencies Vite pre-bundles at dev start. Every entry must belong to a package apps/web
 * declares: an entry Vite cannot resolve logs "Failed to resolve dependency" on every dev start
 * (the Clerk entries lingered after the desktop dropped Clerk and the web stopped importing it).
 */
export const OPTIMIZE_DEPS_INCLUDE: ReadonlyArray<string> = [
  "react-dom/client",
  "effect/Order",
  "effect/Array",
  "@pierre/diffs/worker/worker.js",
  "@pierre/diffs/react",
  "@pierre/diffs/editor",
  "@pierre/diffs",
];
