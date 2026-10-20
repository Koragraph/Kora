# Patches to the vendored koragraph

Engine behaviour is unchanged from the source commit (`VENDOR.json`) except for one fix below. The other edits are
wording.

**Behaviour fix (2026-09-27): a disconnected MCP client no longer floods the logs.** When the client went away, the
EPIPE from writing a tool's answer reached the global `uncaughtException` handlers, which logged it to the equally dead
stderr, which failed again and was logged again. Measured: ~70 MB/s into the file logs (3.6 GB in five minutes) and the
process never exited. Now `src/common-services/pipe-guard.js` recognises "the other end is gone" errors; `src/mcp/start.js`
exits 0 on them (a stdio server lives as long as its client); `src/common-services/logger.js` stops writing to the
console instead of logging the failure (it never exits: it also runs inside the Kora daemon); both rate-limit repeated
uncaught errors; file logs keep 7 rotations instead of every rotation of 14 days. Test: `test/mcp-client-gone.test.js`.

**Behaviour fixes (2026-09-30, graph stability audit).** Nine problems found by indexing several repos into one store and
renaming/moving/deleting things under it. Engine edits (each has a regression in `test/graph-hardening.test.js`):

| Fix | Where |
|---|---|
| A file deleted then restored with identical content (rename back, `git checkout` of a branch that deleted it) stayed REMOVED for ever: the incremental sha-skip matched its stale row | `src/services/ingest.js` `runIncrementalIngest` (`storedFileShas` ignores `REMOVED` rows) |
| …and the untouched files that called into a restored/renamed file lost those edges (new node ids, scoped call re-scan): the call pass is re-run over every file when a run restores or moves files | `ingest.js` (`relinkAll`), `ingest-post-tail.js` |
| Concurrent ingests died with "database is locked" (2 s busy timeout, DEFERRED transactions upgrading after another writer committed): ingest waits up to 120 s, transactions are `BEGIN IMMEDIATE`; the first-ever project insert no longer races | `src/db/sqlite-pool.js`, `src/cli/ingest.js` (`ensureProject`, busy timeout) |
| Repositories were keyed by folder BASENAME: two checkouts named `app` shared one row and overwrote each other. Names are now per checkout (`app`, `app~<parent>`), a row whose folder is gone is adopted (moved repo), the row follows the folder on an "unchanged" ingest; live-freshness refuses to catch a checkout up into another checkout's row | new `src/services/repo-name.js`, `src/cli/ingest.js`, `src/services/live-freshness.js` |
| Files deleted while untracked left live nodes until `--full` (git diff never names them): an ingest that finds nothing to do (or an incremental one) sweeps the branch's file rows against the disk | new `src/services/store-hygiene.js` (`reapGoneFiles`), `src/cli/ingest.js` |
| Renamed/moved/deleted repo folders left a full ghost index for ever; ARCHIVED nodes were never collected: twin of a renamed folder is removed at once (its last commit is in the new checkout), other missing repos after a 7-day grace, archived nodes after 14 days; `kora graph prune` runs it on demand | `store-hygiene.js` (`pruneTwins`, `pruneMissingRepos`, `gcArchivedNodes`, `routineHygiene`) |
| A first index of a big repo took 4–11 min in a store that already held other repos (38 s in an empty one): `+n.repository_branch_id` keeps the planner on `idx_nodes_file_id` instead of scanning every node of the branch once per file | `ingest.js` (3 queries incl. `reconcileCoverageNodeCounts`) |
| git's `warning: could not open directory …` leaked into tool answers | `src/services/repo-watcher.js`, `git-hooks.js` (stderr piped) |
| `KORAGRAPH_SLOW_SQL_MS=<n>` logs every statement slower than n ms with its query plan | `src/db/sqlite-pool.js` |

**Behaviour fixes (2026-10-02, launch-readiness graph run).** Regressions in `test/graph-hardening-2.test.js`.

| Fix | Where |
|---|---|
| Any repo with a `.swift` file never finished indexing: V8's optimizing wasm tier (Turboshaft, Node 24) aborts the whole process compiling the Swift grammar ("Fatal process out of memory: Zone", exit 133, no JS error to catch), leaving the index "incomplete" for good. Only `node --liftoff-only` on the command line avoids it (no runtime/NODE_OPTIONS form; no slowdown measured). `bin/koragraph.js` re-runs `ingest` / `catch-up` under the flag, the catch-up child is spawned with it, and a process without it never loads such a grammar (`assertGrammarSafe`: the file gets a FILE node only, the process lives) | `bin/koragraph.js`, `src/services/ast-extractor.js` (`WASM_NEEDS_LIFTOFF_ONLY`, three loaders), `src/services/extractors/base.js`, `src/services/live-freshness.js` |
| Edits to files the classifier does not route (Swift, Kotlin, Scala, Lua, Dart, Zig, shell, Objective-C, Solidity, OCaml, ReScript — indexed only by the full run's generic tree-sitter pass) never reached the graph: the incremental path skipped them as `not_extractable`, so commits and query-time catch-ups left their declarations as of the first index. The generic per-file writer is shared (`writeGenericAstFile`) and run by the incremental path too; it now also archives the file's declarations that are gone (a rename left the old name live, even across `--full`) | `src/services/ingest.js` |
| A dirty Swift file caught up by a process without `--liftoff-only` (a `kora graph` CLI call, the MCP server) would be stored with no declarations and then never re-checked (content matched): such files are handed to the detached catch-up child, which has the flag | `src/services/live-freshness.js` (`runCatchUp`), `src/services/ast-extractor.js` (`needsLiftoffOnly`) |
| A full index that died part-way followed by a commit was patched incrementally (only the diff re-extracted), so the partial graph stayed partial until a later run happened to land on an unchanged HEAD: the HEAD-moved path now checks the last full job too and rebuilds in full | `src/cli/ingest.js` |
| koragraph's git re-index hooks ran `ingest` in the committer's environment, so a runtime on a non-default store (Kora Dev's `~/.kora-dev/koragraph`, a test daemon) re-indexed into the DEFAULT store on every commit. `installHooks` takes `env`; kora passes `KORA_HOME` / `KORAGRAPH_*` when they are set (no env → the block is byte-identical) | `src/services/git-hooks.js` (`reindexCommand`) |
| A file with thousands of declarations (generated API clients, schema dumps) indexed quadratically: the CONTAINS writer joined node↔node on `file_id` and walked every node of the file once per node of the file (a 20k-export file: 19 s for that one statement; 12k in a store that already held a repo: 9 s). Now driven from the branch's FILE nodes with a fixed join order (`CROSS JOIN`, `+n.repository_branch_id`): 9 ms / 63 ms on the same shapes | `src/services/ingest.js` (`writeContainsEdges`) |
| An uncommitted edit the query path caught up, then reverted (`git checkout -- f`, `git stash`), stayed in the graph for good: git status went quiet, so nothing looked at the file again, and `ingest` at the same HEAD said "unchanged". Every working-tree catch-up (repo- and file-scoped) is recorded in `freshness_handed`; clean-again paths whose stored content differs from disk are re-extracted on the next repo-scoped read and by `ingest`'s unchanged path; in-sync paths are forgotten | `src/services/live-freshness.js` (`revertedHanded`, `catchUpReverted`), `src/cli/ingest.js` |
| explore named a caller by its own declaration line only, so every "list the call sites, file:line" prompt re-grepped for lines the CALLS edges already carry (`call_line`): the `callers:` line now reads `neighbours@src/mcp/tool-handlers.js:378 (call at :394)` (several sites `:492/:510`, never a comma) | `src/mcp/tool-handlers.js` (`renderCallerRefs`) |
| explore demoted every 1–3 line function as a trivial getter even when the query NAMED it: `who calls signatureOf` focused `errorSignatureOf` / `runWatch` and the prompt injection carried the wrong body. A declaration whose identifier-shaped name appears verbatim in the query (or is the whole query) is no longer demoted; a plain word equal to a getter name still is | `src/mcp/tool-handlers.js` (`explore`, `namedByQuery`) |

**Security hardening (2026-10-04, `docs/qa/security-2026-10-04/02-runtime-exec-fs.md`).** Hostile repository content and
hostile refs never reach a shell, never become git options and never redirect a write outside the repository. Tests:
`test/security-hardening.test.js`.

| Fix | Where |
|---|---|
| `LocalProvider` ran every git command as a `/bin/sh` string with refs, file paths and dates interpolated (a file named `$(…)`, a branch named `;…`): now `execFileSync('git', argv)`; revisions starting with `-` are refused; a direct read never leaves the checkout | `src/services/vcs/local-provider.js` (`git`, `revArg`) |
| A hook file that is a symlink (a tracked `core.hooksPath` dir can point `post-commit` at `~/.zshrc`) was appended to through the link; it is now skipped (`skipped-symlink`) and never removed | `src/services/git-hooks.js` (`installHook`, `uninstallHook`) |
| `git clone <url>`: a URL starting with `-` (`--upload-pack=…`) was a git option; `--` now precedes it | `src/services/vcs/git-clone.js` |
| Background `git status` / `git diff HEAD` ran a repo's configured `core.fsmonitor` command; those calls pass `-c core.fsmonitor=false` | `src/services/repo-watcher.js`, `src/practice/git-history.js` (`dirtyFiles`), `local-provider.js` |
| The store directory is created owner-only (0700): it holds source excerpts of every repo indexed | `src/db/pool.js` |
| `koragraph serve` answered any Host/Origin on its loopback port, so a DNS-rebound web page could read the embedded graph (names, files, repos, memory facts); it now serves only a loopback Host on its own port, refuses a cross-site Origin / `Sec-Fetch-Site`, GET/HEAD only, with `X-Frame-Options: DENY` and a CSP | `src/cli/serve.js` (`makeHandler`) |

Wording edits:

| File | Edit |
|---|---|
| `src/cli/status.js`, `src/cli/ingest.js` | one SQL table alias in the co-change count query renamed (now `m3`) |
| `src/services/resolution/resolve.js` | a comment's list of JSONC-emitting frameworks shortened |
| `src/services/ingest.js` | LFS-pointer summary says "bytes on the remote" |
| `src/services/graph-retriever.js` | one debug log line reworded ("caller-side hop traversal") |
| `src/services/resolution/post-resolution.js`, `src/practice/repo-identity.js`, `src/practice/revalidate.js` | comment wording |

Everything kora changes about koragraph's behaviour is layered on from outside:

| Behaviour | Where |
|---|---|
| Memory tools (`remember`, `recall`) not exposed | `src/graph/service.ts` (only `GRAPH_TOOLS` are callable), `src/cli/commands/mcp.ts` (filtered from tools/list, rejected in tools/call) |
| Per-call repo scoping (the daemon serves many cwds) | `src/graph/service.ts` passes `deps.cwd` + `deps.repoId` on every call |
| MCP schema trimmed (3,321 → 1,920 tokens) | `src/graph/tool-trim.ts` |
| Result slimming (source excerpts capped, pseudo-callers dropped) | `src/graph/service.ts#slim` |
| stderr narration filtered on the read path | `src/graph/embedded.ts#quietStderr` (uses koragraph's own `stderr-filter.js`) |
| Ingest lock across processes | `src/graph/lock.ts` |
| Linked worktrees share the main checkout's index | `src/graph/service.ts#repoRoot` |

Reaching into koragraph internals by path (`kg('src/…')`) is the known coupling; the modules used are the
`kg('src/…')` call sites under `packages/runtime/src` (`rg -o "kg\('src/[^']*'" src`).

**Behaviour fix (2026-10-10, final QA).** `search_code` with an identifier that names a declaration exactly returns that
declaration first and drops rows whose name does not even contain the query (it returned 13 rows over 6 files for one exact
hit): `src/mcp/tool-handlers.js` `exactNameFirst`. Test: `test/search-exact-first.test.js`.

**Behaviour fix (2026-10-13, deep audit A2).** Two first ingests into a brand-new store (a fresh install, two Index clicks)
failed "database is locked" about 1 in 10: switching the new file to WAL needs an exclusive lock and SQLite runs no busy
handler for that pragma. `journal_mode = WAL` is now retried on SQLITE_BUSY for the open timeout:
`src/db/sqlite-pool.js` (`pragmaRetryingBusy`). Test: `test/sqlite-open-race.test.js`.

**Behaviour fix (2026-10-13, deep audit A2).** Two first ingests of different checkouts with the same folder name
(`~/a/app`, `~/b/app`) started together both picked the name `app` (the name was read before, and the row written long
after) and shared one row: one checkout's index was silently replaced, and it could never be indexed again (every later
ingest said "done" and the repo stayed "not indexed"). The name is now picked and the row written in one write
transaction: `src/services/repo-name.js` (`claimRepoName`), `src/cli/ingest.js`. Test: `test/repo-name-race.test.js`.

**Behaviour fix (2026-10-14, daemon freeze).** The UI's graph reads ran a query plan that never finished on a grown store
(stale or missing planner statistics). Every ingest and catch-up now ends with `PRAGMA optimize` (bounded
`analysis_limit`): `src/services/store-hygiene.js` (`refreshPlannerStats`), called from `src/cli/ingest.js`. Test:
`test/planner-stats.test.js`.

**Windows port (2026-10-15).** `git rev-parse --show-toplevel` prints `C:/a/b` on Windows while every caller compares it
with Node-built `C:\a\b` paths, so incremental ingests rebased every changed file out of scope. `gitTopLevel` in
`src/services/ingest.js` now returns `path.resolve(top)` (a no-op on macOS/Linux).
A damaged store (a file that is not a database) failed inside `SqlitePool`'s constructor (`assertDriverFloor`) or the
schema probe in `src/db/pool.js` after the handle was open; the failed `require` left that handle open for the life of
the process, and Windows cannot rename an open file, so the quarantine never moved the store aside. Both now close the
handle before rethrowing.

**Behaviour fix (2026-10-15, ghost declarations).** A full index after a branch switch (the chip's Full re-index, or the
rebuild after a failed run) writes a new `repository_branches` row per branch name, and the old row stayed `is_tracked`.
Repo scope is "every tracked branch", so every query answered from both: `neighbours graphReady` on the kora repo listed
the declaration twice (L289 from a stale `feature` branch row, L306 from `main`) plus a caller that no longer existed, and the
stale row doubled the store (121k nodes). Worse, later catch-ups went to the OLDEST row (`ORDER BY rb.id`), so the fresh
row never got them. A completed ingest (full or incremental) now leaves only its own row tracked
(`src/services/ingest.js` `trackOnlyBranch`; the old row is kept, and re-tracked if that branch is indexed again), and
`findIndexedBranch` (`src/cli/ingest.js`) picks the tracked, most recently synced row. Test: `test/branch-switch-scope.test.js`.
A store that already has two tracked rows heals on its next completed ingest of that repo.

**Behaviour fix (2026-10-15, workspace folders).** A plain (non-git) folder indexed for its loose files and holding other
indexed checkouts (`~/Projects/koraplex`: 77 nodes of notes around `kora/`, `kora-dev/` …) is now pruned at once by
`findMissingRepos` / `pruneMissingRepos` (reason `holds-checkouts`, no grace period: the folder is present)
in `src/services/store-hygiene.js`. Agents opened there were told real symbols did not exist (the runtime side stops
resolving to such a row: `holdsCheckouts` in `packages/runtime/src/graph/service.ts`). Test: `test/prune-workspace-folder.test.js`.

**Behaviour fix (2026-10-15, audit 4-bugs-graph #1).** `src/services/live-freshness.js` wrote a dirty file's content hash
to `freshness_handed` (and the per-process `submitted` memo) BEFORE any catch-up ran. A file edited while a background
catch-up was already in flight, or one whose catch-up failed / timed out on the ingest lock / never spawned, stayed
marked handed and every later read skipped it — the graph held its old declarations until a commit. `runCatchUp` now
records the handed hashes (taken before extraction) only after a successful run and returns `true`/`false`; the memo is
set only when a run is actually dispatched and dropped when it ends. `koragraph catch-up` exits 1 on a failed run.
Test: `test/live-freshness-dirty-noop.test.js` (last case).

**Behaviour fix (2026-10-15, audit #5).** `src/cli/catch-up.js` sets the same `busy_timeout` as `ingestAll`
(`KORAGRAPH_INGEST_BUSY_MS`, default 120 s) so the detached catch-up waits for another repo's ingest instead of failing
"database is locked" after 2 s. Test: `test/catch-up-busy.test.js`.

**Behaviour fix (2026-10-15, audit #6).** `src/services/ingest-lock.js`: a stale lock is replaced only by the holder of an
exclusive-create `<lock>.takeover` file, after re-reading the lock (two waiters used to both unlink + create, the second
deleting the first's fresh lock). The lock is keyed on `realpath`, so `/tmp/x` and `/private/tmp/x` share one.
Test: `test/ingest-lock-takeover.test.js`. Same file in `koragent/packages/koragraph-engine`.

**Behaviour fix (2026-10-15, audit #2).** `src/services/repo-name.js` `resolveRepoName` step 2 adopts a gone row with the
same basename only when it is the same repository (`sameRepoIdentity`: the row's indexed commit exists in this
checkout's history, and a recorded remote agrees). A row with no recorded commit cannot be checked and is not adopted
(both sides reject it). An unrelated same-named repo gets its own row. The runtime's
`movedRow` (`packages/runtime/src/graph/service.ts`) uses the same check. Test: `packages/runtime/src/graph/moved-identity.test.ts`.

**Behaviour fix (2026-10-15, review of audit #1).** `src/services/live-freshness.js` `spawnCatchUp` no longer starts a
catch-up child while another live run holds the repo's ingest lock (`ingest-lock.js` `isHeld`; a stale lock does not
count), and backs off per branch after a child exits non-zero (2 s, doubling, capped at 5 min; a success clears it), so a
failing catch-up is not respawned on every read. Test: `test/catch-up-backoff.test.js`. Same in `koragent/packages/koragraph-engine`.
