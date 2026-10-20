#!/usr/bin/env node
// Writes the licence notices for every third-party package the app ships (web client, desktop shell, runtime,
// UI server): name, version, licence, homepage and the licence text found in the package.
// Usage: node scripts/third-party-notices.mjs <out.json>     (scripts/build.sh runs it after the web build)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SHIPPED = ["@kora/web", "@kora/desktop", "@kora/runtime", "@kora/ui-server"];
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

const out = resolve(process.argv[2] ?? "third-party-licenses.json");
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");

function licensesFor(filter) {
  const raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json", "--filter", filter], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function licenseText(dir) {
  if (!dir || !existsSync(dir)) return null;
  const file = readdirSync(dir).find((name) => LICENSE_FILE.test(name));
  return file ? readFileSync(join(dir, file), "utf8").trim() : null;
}

const byKey = new Map();
for (const filter of SHIPPED) {
  for (const [license, packages] of Object.entries(licensesFor(filter))) {
    for (const pkg of packages) {
      if (pkg.name.startsWith("@kora/")) continue;
      pkg.versions.forEach((version, i) => {
        const key = `${pkg.name}@${version}`;
        if (byKey.has(key)) return;
        byKey.set(key, {
          name: pkg.name,
          version,
          license,
          homepage: pkg.homepage ?? null,
          text: licenseText(pkg.paths?.[i]),
        });
      });
    }
  }
}

const notices = [...byKey.values()].sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify({ generatedBy: "scripts/third-party-notices.mjs", packages: notices }, null, 1)}\n`,
);
console.log(`[notices] ${notices.length} packages -> ${out}`);
