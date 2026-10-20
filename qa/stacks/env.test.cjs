"use strict";
// node --test qa/stacks/env.test.cjs  (needs the runtime built: packages/runtime/dist)
// A stack's repos must count as trusted by the daemon's real gate, not just sit in config.trustedRoots.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { RT, trustStackRepos } = require("./env.cjs");

test("trustStackRepos makes stack repos trusted by the runtime trust gate", () => {
  // os.tmpdir() is under /var → /private/var: the store keys realpaths, so this also covers the symlinked tmp.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kora-qa-trust-"));
  const prevHome = process.env.KORA_HOME;
  try {
    const s = { home: path.join(base, "home"), repos: path.join(base, "repos") };
    process.env.KORA_HOME = s.home;
    const store = require(path.join(RT, "dist/trust/store.js"));
    store._resetTrustCacheForTests();
    const repo = path.join(s.repos, "app");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"));
    assert.equal(store.isFolderTrusted(repo), false); // the old config.trustedRoots alone never trusted it

    trustStackRepos(s);
    trustStackRepos(s); // idempotent
    store._resetTrustCacheForTests();
    assert.equal(store.isFolderTrusted(repo), true);
    assert.equal(store.isFolderTrusted(path.join(repo, "src")), true);
    assert.equal(store.listTrustedFolders().length, 1);

    // A spec's own grant is kept on the next stack start.
    const other = path.join(base, "other");
    fs.mkdirSync(path.join(other, ".git"), { recursive: true });
    store.trustFolder(other);
    trustStackRepos(s);
    store._resetTrustCacheForTests();
    assert.equal(store.isFolderTrusted(other), true);
    assert.equal(store.listTrustedFolders().length, 2);
  } finally {
    if (prevHome === undefined) delete process.env.KORA_HOME;
    else process.env.KORA_HOME = prevHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
