#!/usr/bin/env node
// Summarise qa/findings/*.jsonl: node qa/scripts/findings.mjs [--round r1] [--area 02] [--full]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../findings");
const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i === -1 ? null : args[i + 1];
};
const round = opt("--round");
const area = opt("--area");
const full = args.includes("--full");
const order = { crash: 0, broken: 1, wrong: 2, visual: 3, copy: 4 };

const all = [];
for (const f of fs
  .readdirSync(DIR)
  .filter((x) => x.endsWith(".jsonl") && !x.includes(".coverage"))) {
  if (area && !f.startsWith(area)) continue;
  for (const l of fs.readFileSync(path.join(DIR, f), "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const d = JSON.parse(l);
      if (!round || d.round === round) all.push(d);
    } catch {
      /* skip */
    }
  }
}
all.sort(
  (a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || a.area.localeCompare(b.area),
);
const counts = {};
for (const d of all) {
  counts[d.area] ||= {};
  counts[d.area][d.severity] = (counts[d.area][d.severity] || 0) + 1;
}
console.log(`${all.length} findings${round ? ` in ${round}` : ""}`);
for (const [a, c] of Object.entries(counts).sort())
  console.log(
    `  ${a.padEnd(28)} ${Object.entries(c)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ")}`,
  );
console.log("");
all.forEach((d, i) => {
  console.log(`#${i + 1} [${d.severity}] ${d.area} › ${d.control}`);
  console.log(`    expected: ${String(d.expected).slice(0, full ? 2000 : 220)}`);
  console.log(
    `    actual:   ${String(d.actual)
      .slice(0, full ? 2000 : 300)
      .replace(/\n/g, " ⏎ ")}`,
  );
  if (full)
    console.log(
      `    steps: ${(d.steps || []).join(" → ")}\n    shot: ${d.screenshot}\n    evidence: ${JSON.stringify(d.evidence).slice(0, 800)}`,
    );
});
