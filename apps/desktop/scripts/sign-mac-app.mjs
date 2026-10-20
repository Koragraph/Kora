#!/usr/bin/env node
// sign-mac-app.mjs — Developer ID signing for a packaged Kora.app (scripts/package-app.sh --sign). Apple notarizes only
// a bundle whose every Mach-O is signed with the hardened runtime and a secure timestamp: Electron's helpers and
// frameworks (incl. Squirrel's ShipIt, which installs updates), the runtime's native modules, its bundled node and the
// Claude Agent SDK's claude binary. @electron/osx-sign signs them inside-out; each executable that runs JS gets the
// entitlements it needs from ../resources/entitlements, then the app itself is sealed.
//
// usage: node sign-mac-app.mjs --app <Kora.app> --identity "<Developer ID Application: Name (TEAMID)>" [--keychain <path>]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { sign } from "@electron/osx-sign";

const { values } = NodeUtil.parseArgs({
  options: {
    app: { type: "string" },
    identity: { type: "string" },
    keychain: { type: "string" },
  },
});
if (!values.app || !values.identity) {
  console.error(
    'usage: sign-mac-app.mjs --app <Kora.app> --identity "<identity>" [--keychain <path>]',
  );
  process.exit(2);
}

const app = NodePath.resolve(values.app);
const entitlementsDir = NodePath.join(import.meta.dirname, "..", "resources", "entitlements");
const entitlements = (name) => NodePath.join(entitlementsDir, `${name}.plist`);

const MACH_O_MAGIC = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);

/**
 * @electron/osx-sign signs every file that isn't text. Only Mach-O code needs its own signature; everything else (the
 * runtime's .wasm grammars, images, Chromium's .pak data, node-pty's Windows .exe/.dll) is covered by the bundle's
 * seal, and signing it only costs a keychain check and a timestamp round trip per file (94 of 122 files).
 */
function isMachO(filePath) {
  let fd;
  try {
    fd = NodeFS.openSync(filePath, "r");
    const magic = Buffer.alloc(4);
    return NodeFS.readSync(fd, magic, 0, 4, 0) === 4 && MACH_O_MAGIC.has(magic.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) NodeFS.closeSync(fd);
  }
}
const skipUnlessCode = (filePath) => !NodeFS.statSync(filePath).isDirectory() && !isMachO(filePath);

/** Which entitlements a file is signed with; undefined keeps @electron/osx-sign's default (libraries, frameworks). */
function entitlementsFor(filePath) {
  if (filePath === app) return entitlements("app");
  // The daemon / CLI / hooks run on this node: V8 JIT, plus native addons (better-sqlite3, node-pty).
  if (filePath.endsWith("/Contents/Resources/runtime/bin/node")) return entitlements("node");
  // The Claude Agent SDK's own Claude Code binary (the chat lane runs it): keep what Anthropic signs it with.
  if (/\/claude-agent-sdk-darwin-[^/]+\/claude$/.test(filePath)) return entitlements("claude");
  if (filePath.includes(" Helper (Renderer).app")) return entitlements("helper-renderer");
  if (filePath.includes(" Helper (GPU).app")) return entitlements("helper-gpu");
  if (filePath.includes(" Helper (Plugin).app")) return entitlements("helper-plugin");
  if (filePath.includes(" Helper.app")) return entitlements("app");
  return undefined;
}

await sign({
  app,
  identity: values.identity,
  ...(values.keychain ? { keychain: values.keychain } : {}),
  platform: "darwin",
  type: "distribution",
  // Mac App Store sandbox plumbing; meaningless (and harmful) for a Developer ID build.
  preAutoEntitlements: false,
  ignore: skipUnlessCode,
  strictVerify: true,
  optionsForFile: (filePath) => {
    const file = entitlementsFor(filePath);
    return { hardenedRuntime: true, ...(file ? { entitlements: file } : {}) };
  },
});
console.log(`signed ${app}`);
