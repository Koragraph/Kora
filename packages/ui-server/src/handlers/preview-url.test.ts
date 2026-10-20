import test from "node:test";
import assert from "node:assert/strict";
import { webPreviewUrl } from "./preview.ts";

test("webPreviewUrl keeps web urls and reads a bare host[:port] as http", () => {
  assert.equal(webPreviewUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(webPreviewUrl("http://localhost:5173"), "http://localhost:5173/");
  assert.equal(webPreviewUrl("localhost:3000"), "http://localhost:3000/");
  assert.equal(webPreviewUrl("localhost:3000/app"), "http://localhost:3000/app");
  assert.equal(webPreviewUrl("example.com"), "http://example.com/");
});

test("webPreviewUrl drops non-web schemes", () => {
  for (const u of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "smb://host/share",
    "vscode://x",
    "data:text/html,x",
    "ms-msdt:x",
    "",
    "   ",
    undefined,
    42,
  ])
    assert.equal(webPreviewUrl(u), undefined, String(u));
});
