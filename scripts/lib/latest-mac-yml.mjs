#!/usr/bin/env node
// latest-mac-yml.mjs <update.zip> <version> <out.yml> — the feed entry electron-updater reads to find, download and
// verify a macOS update (sha512 + size of the zip Squirrel installs). Used by release-app.sh and test-update-flow.sh.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [zip, version, out] = process.argv.slice(2);
if (!zip || !version || !out) {
  console.error("usage: latest-mac-yml.mjs <update.zip> <version> <out.yml>");
  process.exit(2);
}
const hash = NodeCrypto.createHash("sha512");
for await (const chunk of NodeFS.createReadStream(zip)) hash.update(chunk);
const sha512 = hash.digest("base64");
const name = NodePath.basename(zip);
const size = NodeFS.statSync(zip).size;
NodeFS.writeFileSync(
  out,
  [
    `version: ${version}`,
    "files:",
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ].join("\n"),
);
