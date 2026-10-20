#!/usr/bin/env node
// Windows-portability lint: runs only the kora/* portability rules (scripts/oxlint-windows.json) over the code that
// ships or runs on Windows — the runtime (which the root `pnpm lint` skips), the ui-server, the desktop shell and the
// Windows scripts. Usage: pnpm lint:win [--summary] [extra oxlint args or paths]. See docs/windows/DEV.md.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// oxlint is a transitive dependency of vite-plus (same lookup as packages/oxlint-plugin-kora/test/utils.ts).
const require = createRequire(
  createRequire(path.join(root, "package.json")).resolve("vite-plus/package.json"),
);
const oxlintBin = path.join(path.dirname(require.resolve("oxlint/package.json")), "bin", "oxlint");

const TARGETS = [
  "packages/runtime/src",
  "packages/runtime/bin",
  "packages/runtime/scripts/postinstall.js",
  "packages/runtime/scripts/test-isolate.cjs",
  "packages/ui-server/src",
  "apps/desktop/src",
  "apps/desktop/resources",
  "scripts/package-win.mjs",
  "scripts/smoke-win.mjs",
];

const args = process.argv.slice(2);
const summary = args.includes("--summary");
const rest = args.filter((a) => a !== "--summary");
const targets = rest.some((a) => !a.startsWith("-")) ? [] : TARGETS;

const res = spawnSync(
  process.execPath,
  [oxlintBin, "--config", "scripts/oxlint-windows.json", "--format", "unix", ...rest, ...targets],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (res.error) throw res.error;
const lines = res.stdout.split("\n").filter((l) => /^[^:]+:\d+:\d+: /.test(l));

if (!summary || (lines.length === 0 && res.status !== 0)) {
  process.stdout.write(res.stdout);
} else {
  // One line per rule, then files ranked by count, split into src and tests.
  const byRule = new Map();
  const byFile = new Map();
  for (const l of lines) {
    const rule = /kora\(([\w-]+)\)\]$/.exec(l)?.[1] ?? "?";
    const file = l.slice(0, l.indexOf(":"));
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    const key = `${rule}  ${file}`;
    byFile.set(key, (byFile.get(key) ?? 0) + 1);
  }
  for (const [rule, n] of [...byRule].sort()) {
    const tests = lines.filter((l) => l.includes(rule) && /\.test\.[cm]?[jt]s:/.test(l)).length;
    console.log(`${rule}: ${n} (${n - tests} src, ${tests} tests)`);
  }
  console.log("");
  for (const [key, n] of [...byFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
    console.log(`${String(n).padStart(4)}  ${key}`);
}
process.stderr.write(res.stderr);
process.exit(res.status ?? 1);
