// @effect-diagnostics nodeBuiltinImport:off -- a plain node:test harness on throwaway files.
// Security sweep 2026-10-04 (docs/qa/security-2026-10-04/01-daemon-server.md): regressions for the daemon-side input
// hardening — bounded file reads, symlink-safe workspace writes, attachment response headers.
import test from "node:test";
import assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readHead } from "./handlers.ts";
import { resolvesOutside } from "./handlers/workspace.ts";
import { attachmentHeaders } from "./http.ts";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kora-sec-")));

test("readHead never reads a device or FIFO, and reads at most `max` bytes of a big file", () => {
  // /dev/zero is endless: a plain readFileSync on it never returned (the daemon's event loop was gone).
  const posix = process.platform !== "win32"; // no /dev/zero or mkfifo on Windows
  if (posix) assert.equal(readHead("/dev/zero", 1024).regular, false);
  const dir = tmp();
  try {
    if (posix) {
      const fifo = path.join(dir, "pipe");
      cp.execFileSync("mkfifo", [fifo]);
      assert.equal(readHead(fifo, 1024).regular, false); // opened non-blocking: no writer, no hang
    }
    const big = path.join(dir, "big.txt");
    fs.writeFileSync(big, "x".repeat(4096));
    const r = readHead(big, 1000);
    assert.equal(r.regular, true);
    assert.equal(r.slice.byteLength, 1000);
    assert.equal(r.byteLength, 4096);
    const small = path.join(dir, "small.txt");
    fs.writeFileSync(small, "hello");
    assert.equal(readHead(small, 1000).slice.toString(), "hello");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a workspace write cannot follow a symlink out of the workspace", () => {
  const base = tmp();
  try {
    const root = path.join(base, "repo");
    const outside = path.join(base, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "docs")); // a cloned repo can commit this
    fs.symlinkSync(path.join(outside, "f.txt"), path.join(root, "link.txt"));
    fs.symlinkSync(path.join(base, "nowhere"), path.join(root, "dangling"));
    assert.notEqual(resolvesOutside(root, path.join(root, "docs", "authorized_keys")), null);
    assert.notEqual(resolvesOutside(root, path.join(root, "docs", "new", "deep.txt")), null);
    assert.notEqual(resolvesOutside(root, path.join(root, "link.txt")), null);
    assert.notEqual(resolvesOutside(root, path.join(root, "dangling")), null);
    // Ordinary writes, new folders and links that stay inside are fine.
    fs.mkdirSync(path.join(root, "src"));
    fs.symlinkSync(path.join(root, "src"), path.join(root, "alias"));
    assert.equal(resolvesOutside(root, path.join(root, "src", "a.ts")), null);
    assert.equal(resolvesOutside(root, path.join(root, "new", "dir", "b.ts")), null);
    assert.equal(resolvesOutside(root, path.join(root, "alias", "c.ts")), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("attachment headers: never a header Node refuses, active types download sandboxed", () => {
  // macOS screenshot names carry U+202F; Node threw on the raw name in the header.
  const shot = attachmentHeaders("Screenshot 2026-10-04 at 9.41.02 PM.png", "image/png");
  assert.equal(shot.contentType, "image/png");
  assert.match(
    shot.headers["content-disposition"]!,
    /^inline; filename="[\x20-\x7e]+"; filename\*=UTF-8''/,
  );
  assert.equal(shot.headers["x-content-type-options"], "nosniff");
  assert.equal(shot.headers["content-security-policy"], undefined);
  const html = attachmentHeaders('evil".html', "text/html");
  assert.match(html.headers["content-disposition"]!, /^attachment; filename="evil_.html"/);
  assert.match(html.headers["content-security-policy"]!, /sandbox/);
  const svg = attachmentHeaders("x.svg", "image/svg+xml");
  assert.match(svg.headers["content-disposition"]!, /^attachment;/);
  // A type with CR/LF (the schema only bounds its length) falls back instead of breaking the response.
  assert.equal(
    attachmentHeaders("a", "text/plain\r\nx-evil: 1").contentType,
    "application/octet-stream",
  );
  // A lone surrogate made encodeURIComponent throw.
  assert.doesNotThrow(() => attachmentHeaders("bad\ud800.png", "image/png"));
  for (const v of Object.values(
    attachmentHeaders("né\r\n\u{1F600}.pdf", "application/pdf").headers,
  ))
    assert.match(v, /^[\t\x20-\x7e]*$/);
});
