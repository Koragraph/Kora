#!/usr/bin/env node
// kora-runtime-manifest.cjs — integrity manifest for the kora runtime copy (~/.kora/app, ~/.kora-dev/app, …).
//
// Why: Kora.app copies its signed runtime (a pinned node + the daemon's JS) to a user-writable directory and starts
// the daemon from there (see kora-runtime.sh for why a copy). Any process running as the user could edit that JS, and
// the next daemon Kora.app starts would run the edit with Kora's macOS privacy grants (the app is the responsible
// process). The bundle itself is sealed by its code signature and, in /Applications, protected by macOS App
// Management; the copy is not. So:
//
//   generate <runtimeDir> <manifest.json> [buildId]
//       package-app.sh, before signing: sha256 of every regular file, every symlink's target, the exec bit. Mach-O
//       files (node, native addons) are flagged instead of hashed — signing rewrites them after this runs — and are
//       compared byte-for-byte against the bundle's own (sealed) copy at verify time.
//   verify <copyDir> <manifest.json> <bundleRuntimeDir>
//       kora-runtime.sh, before it (re)starts the daemon: exit 0 when the copy matches, 1 with the differences when it
//       does not (the script then re-copies from the bundle), 2 on usage / I/O errors (treated like a mismatch).
//
// Runs under the BUNDLE's node (never the copy's), dependency-free, CommonJS.
"use strict";

const NodeCrypto = require("node:crypto");
const NodeFS = require("node:fs");
const NodePath = require("node:path");

const MANIFEST_VERSION = 1;
const HASH_CONCURRENCY = 16;
/** Files a node process might load or exec. An unexpected one of these in the copy is a mismatch. */
const CODE_LIKE = /\.(?:c?js|mjs|json|node|wasm|sh|dylib|so|py|pth)$/i;
const MACHO_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);

function toPosix(relative) {
  return relative.split(NodePath.sep).join("/");
}

/** Every entry under `root` (lstat: symlinks are reported, never followed). */
function walk(root) {
  const entries = [];
  const stack = [""];
  while (stack.length > 0) {
    const relativeDir = stack.pop();
    const absoluteDir = NodePath.join(root, relativeDir);
    for (const dirent of NodeFS.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relative = relativeDir === "" ? dirent.name : NodePath.join(relativeDir, dirent.name);
      const absolute = NodePath.join(root, relative);
      const stat = NodeFS.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        entries.push({ path: toPosix(relative), type: "l", target: NodeFS.readlinkSync(absolute) });
      } else if (stat.isDirectory()) {
        stack.push(relative);
      } else if (stat.isFile()) {
        entries.push({
          path: toPosix(relative),
          type: "f",
          exec: (stat.mode & 0o111) !== 0,
          absolute,
        });
      } else {
        entries.push({ path: toPosix(relative), type: "other" });
      }
    }
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function isMachO(absolute) {
  let fd;
  try {
    fd = NodeFS.openSync(absolute, "r");
    const buffer = Buffer.alloc(4);
    if (NodeFS.readSync(fd, buffer, 0, 4, 0) < 4) return false;
    return MACHO_MAGICS.has(buffer.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) NodeFS.closeSync(fd);
  }
}

function hashFile(absolute) {
  return new Promise((resolve, reject) => {
    const hash = NodeCrypto.createHash("sha256");
    const stream = NodeFS.createReadStream(absolute, { highWaterMark: 1 << 20 });
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function mapLimit(items, limit, fn) {
  const results = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function generateManifest(runtimeDir, buildId) {
  const entries = walk(runtimeDir);
  const files = {};
  await mapLimit(entries, HASH_CONCURRENCY, async (entry) => {
    if (entry.type === "l") {
      files[entry.path] = { t: "l", to: entry.target };
    } else if (entry.type === "f") {
      files[entry.path] = isMachO(entry.absolute)
        ? { t: "f", x: entry.exec, m: 1 }
        : { t: "f", x: entry.exec, h: await hashFile(entry.absolute) };
    } else {
      throw new Error(`unsupported file type in the runtime: ${entry.path}`);
    }
  });
  const sorted = {};
  for (const key of Object.keys(files).sort()) sorted[key] = files[key];
  return { v: MANIFEST_VERSION, build: buildId ?? null, files: sorted };
}

/** Returns the list of problems (empty when the copy matches). */
async function verifyRuntime(copyDir, manifest, bundleRuntimeDir) {
  if (!manifest || manifest.v !== MANIFEST_VERSION || typeof manifest.files !== "object") {
    return ["manifest is missing or of an unknown version"];
  }
  const problems = [];
  const expected = manifest.files;
  const seen = new Set();
  const toHash = [];
  for (const entry of walk(copyDir)) {
    const want = Object.prototype.hasOwnProperty.call(expected, entry.path)
      ? expected[entry.path]
      : undefined;
    if (want === undefined) {
      if (
        entry.type === "l" ||
        entry.type === "other" ||
        entry.exec ||
        CODE_LIKE.test(entry.path)
      ) {
        problems.push(`unexpected ${entry.type === "l" ? "symlink" : "file"}: ${entry.path}`);
      }
      continue;
    }
    seen.add(entry.path);
    if (want.t !== entry.type) {
      problems.push(`type changed: ${entry.path}`);
      continue;
    }
    if (entry.type === "l") {
      if (entry.target !== want.to) problems.push(`symlink retargeted: ${entry.path}`);
      continue;
    }
    // Mode bits are deliberately not compared: node-pty chmods its own spawn-helper at runtime, which made every launch
    // read as tampering (2026-10-14). Content is what counts; a changed file fails its hash below.
    toHash.push({ entry, want });
  }
  for (const path of Object.keys(expected)) {
    if (!seen.has(path)) problems.push(`missing: ${path}`);
  }
  await mapLimit(toHash, HASH_CONCURRENCY, async ({ entry, want }) => {
    const actual = await hashFile(entry.absolute);
    let reference = want.h;
    if (want.m === 1) {
      if (!bundleRuntimeDir) {
        problems.push(`no bundle to compare a binary against: ${entry.path}`);
        return;
      }
      // oxlint-disable-next-line kora/no-slash-split-path -- manifest paths are written with "/" on every OS (toPosix)
      reference = await hashFile(NodePath.join(bundleRuntimeDir, ...entry.path.split("/"))).catch(
        () => null,
      );
    }
    if (actual !== reference) problems.push(`modified: ${entry.path}`);
  });
  return problems.sort();
}

async function main(argv) {
  const [mode, ...args] = argv;
  if (mode === "generate" && args.length >= 2) {
    const manifest = await generateManifest(args[0], args[2]);
    NodeFS.writeFileSync(args[1], `${JSON.stringify(manifest)}\n`, { mode: 0o644 });
    process.stdout.write(`runtime manifest: ${Object.keys(manifest.files).length} entries\n`);
    return 0;
  }
  if (mode === "verify" && args.length >= 3) {
    const manifest = JSON.parse(NodeFS.readFileSync(args[1], "utf8"));
    const problems = await verifyRuntime(args[0], manifest, args[2]);
    if (problems.length === 0) return 0;
    process.stdout.write(
      `runtime copy differs from the signed bundle (${problems.length}): ${problems.slice(0, 10).join("; ")}${
        problems.length > 10 ? "; …" : ""
      }\n`,
    );
    return 1;
  }
  process.stderr.write(
    "usage: kora-runtime-manifest.cjs generate <dir> <out.json> [buildId] | verify <copy> <manifest.json> <bundleRuntime>\n",
  );
  return 2;
}

module.exports = { generateManifest, verifyRuntime, isMachO };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(
        `kora-runtime-manifest: ${error && error.message ? error.message : String(error)}\n`,
      );
      process.exit(2);
    },
  );
}
