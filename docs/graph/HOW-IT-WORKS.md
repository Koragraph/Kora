# The code graph: how it works

Kora keeps an index of your repository's **declarations** (functions, methods, classes, constants, files) and the
**edges** between them (calls, imports, extends, contains). Agents use it to find code in one step instead of
grep → Read → Read, and Kora hands them the relevant declarations before they even ask. This page is for beta
testers (what to expect, what to do when something looks wrong) and for developers (where each piece lives).

## 1. The store

- One SQLite file per machine: `~/.koragraph/graph.db` (Kora Dev: `~/.kora-dev/koragraph/graph.db`). Overridden by
  `KORAGRAPH_DB`, or `KORAGRAPH_HOME/graph.db`. Every part of Kora (CLI, daemon, hooks, chip) resolves it the same way.
- It holds every repository you indexed. Each **checkout** is its own row (two folders both called `app` are
  `app` and `app~<parent>`); a linked git worktree shares its main checkout's index.
- It is derived data. Deleting it loses nothing that a re-index cannot rebuild.
- Housekeeping: `kora graph prune [--dry-run] [--now] [--vacuum]` removes repositories whose folder is gone and
  old soft-deleted ("archived") declarations. It also runs once a day at the end of an ingest.

## 2. Indexing (ingest)

| How it starts                                                                                                             | What runs                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Open project** on any folder                                                                                            | nothing is indexed: the chip / the chat's index line offers it, and the first index starts only on that click (never automatically)                                                                        |
| Graph chip → **Index this repo** (a plain folder, or a repo added before it had git; a thread never starts one by itself) | `kora ingest <main checkout>` as a detached child                                                                                                                                                          |
| Chip → **Re-index now** / **Full re-index**                                                                               | the same, incremental / `--full`                                                                                                                                                                           |
| A code prompt in a repo whose index is behind HEAD, or whose full index died                                              | `freshenIndex` (graph/prompt-inject.ts) starts `kora ingest` in the background                                                                                                                             |
| A commit / checkout / merge / rebase in an indexed repo                                                                   | only after `kora setup` in that repo, which installs git hooks (`post-commit`, `post-checkout`, `post-merge`, `post-rewrite`); app ingests pass `--no-hooks`, so otherwise the next code prompt catches up |
| A worker pane (fleet / swarm) in a repo you indexed whose index is behind HEAD                                            | the daemon's background incremental re-index (`indexInBackground`, server/workspace.ts); never a first index                                                                                               |
| You                                                                                                                       | `kora ingest [path] [--full]` (from an agent's shell it refuses a repo with no index: only the user starts a first index, `graph/index-consent.ts`)                                                        |

- **First index**: every tracked file is parsed with tree-sitter (TS/JS, Python, Go, Rust, Java, C/C++, C#, PHP,
  Ruby, Swift, Kotlin, Scala, Elixir, Lua, Zig, Dart, Vue, shell, Solidity, OCaml, ReScript, Objective-C), then
  the post-file passes resolve calls/imports across files. Measured: a 2,100-file TypeScript monorepo in ~36 s,
  ~0.85 GB peak memory.
- **Incremental**: only the files in `git diff <indexed commit>..HEAD` are re-extracted (~1–9 s). An unchanged HEAD
  is ~1 s ("nothing changed").
- **Skipped on purpose**: `node_modules`, `vendor`, `dist`, `build`, `target`, … (one summary row each), binary
  files, minified/generated files (`*.min.js`, `*.g.dart`, `*.pb.*`), symlinks, nested git checkouts and submodules
  (index those on their own), files larger than 200 KB are chunked.
- **Never indexed**: your home folder, a parent of it, `/`, or a too-shallow path like `/tmp` — `kora ingest`
  refuses them unless you pass `--force`, and the chip does not offer them.
- **Index truth**: an index is whole only when the latest FULL ingest finished. While the first index is still
  running, or after one that died (killed, crashed), the repo reads **not indexed / incomplete**: queries refuse
  rather than answer from half a graph, and the next ingest rebuilds it in full.
- Every ingest and catch-up child runs as `node --liftoff-only` (V8's optimizing wasm compiler aborts the process
  on the Swift grammar and costs ~2 GB of memory on a medium repo).
- One ingest per repo at a time (a lock under `~/.kora/locks` and `~/.koragraph/locks`); different repos can index
  concurrently.
  The repository row is named and written in one write transaction (`claimRepoName`), so two same-named checkouts
  indexed at the same moment get one row each; opening a brand-new store retries the WAL switch.
- Nothing indexes a repository the user never indexed: not opening a project, not a thread, not a worker pane, not an
  agent (`kora ingest` from an agent process, and the socket's `graph.ingest` without the control token, refuse it).

## 3. Staying fresh

- **Uncommitted edits** are folded in at query time (`live-freshness.js`): a query notices changed files with
  `git status`, compares their content with the store, and catches them up in a detached child. The query in
  flight answers from the index as it stood; if you ask for a symbol that only exists in your uncommitted edit,
  the answer says which file declares it. A reverted edit (`git checkout -- f`, `git stash`) is taken back out.
- **Commits / branch switches**: the git hooks re-index incrementally; the next code prompt does too
  (`freshenIndex`). The chip shows **Stale** until then.
- **Worktrees** (agent workers) read the main checkout's index plus an overlay: results whose files the branch
  changed are labelled, and a symbol that is new on the branch is reported as such ("NEW on this branch …").

## 4. Asking the graph

`kora graph <tool>` (shell), the same tools over MCP (`kora mcp`, opt-in for Claude with `KORA_MCP=1`):

| Tool                                    | Answers                                                  |
| --------------------------------------- | -------------------------------------------------------- |
| `explore "<symbol or phrase>"`          | ranked declarations + callers/callees + a source excerpt |
| `search_code X`                         | where a declaration is (file:line only, cheap)           |
| `neighbours X --direction in`           | exact callers / callees                                  |
| `blast_radius --file <path>`            | what depends on a file before you edit it                |
| `file_symbols <path>`                   | every declaration in a file with line ranges             |
| `changes_with X`                        | what tends to change in the same commit (git-mined)      |
| `overview`                              | hubs and hotspots of the repo                            |
| `status` · `brief` · `ingest` · `prune` | housekeeping                                             |

Queries are scoped to the repository that contains the current folder. Outside any indexed repository they refuse
(`--repo all` searches every indexed repo on purpose). Results are slimmed: long source excerpts are capped with the
exact range to Read; hits whose file does not exist in this checkout are dropped and counted.

## 5. How agents are made to use it

| Channel                                                                                                                                                                                                                                                                                                           | Claude chat (SDK)                                  | Codex chat                                      | Worker panes (Claude/Codex/OpenCode)                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Per-prompt injection**: for a code-shaped prompt, the matching declarations (file:line, and the body of a small top hit) are prepended to the prompt                                                                                                                                                            | ClaudeDriver (in the daemon)                       | CodexDriver                                     | the `UserPromptSubmit` hook (`kora hook prompt`); OpenCode swarm workers get a graph context packet with their task |
| **Rulebook** (when to use explore / search_code / neighbours / grep)                                                                                                                                                                                                                                              | `CLAUDE.md` managed block + appended system prompt | `AGENTS.md` managed block (+ the session brief) | same files                                                                                                          |
| **Session brief** (repo headline, staleness, how to call the graph)                                                                                                                                                                                                                                               | `SessionStart` hook                                | in `AGENTS.md`                                  | hook / file                                                                                                         |
| **Grep redirect**: a cold search for a code identifier — the `Grep` tool, or one recursive `rg`/`grep` in Bash (Full access steers Claude to Bash) — is denied once and pointed at the graph; text greps, searches in named files, compound commands and Glob always pass; after any graph call everything passes | `PreToolUse` hook                                  | — (no hooks)                                    | Claude panes                                                                                                        |
| **Read dedupe**: a second Read of an unchanged file is nudged; a changed one gets the changed ranges; a whole-file Read of a long file is nudged toward a range                                                                                                                                                   | `PreToolUse`/`PostToolUse` hooks                   | —                                               | Claude panes                                                                                                        |

- The grep/rg PATH shim in panes prints graph hits only for a one-identifier pattern, and only the entries that declare it
  (`enforce/search-shape.ts`). In a linked worktree, `explore`, `neighbours` and `search_code` answers from a file the branch
  changed are re-read from the checkout (`reresolveLines` in `graph/worktree-overlay.ts`): declaration and call-site lines,
  and explore's source excerpt, which the engine otherwise reads at the INDEXED range of today's file. Stale duplicates
  collapse; a declaration that cannot be found keeps its old text under a "line numbers may have moved" label.
- Exactly one injector per prompt: the chat lane sets `KORA_INJECT_OWNER=driver` so the hook does not inject twice.
- Every injection decision is logged to `~/.kora/inject.jsonl` (lane, reason, declarations, ms).
  `pnpm canary` (or `pnpm --filter @kora/runtime canary -- --repo <indexed repo>`) checks that every lane injects.
- The rulebook and hooks are written into a repo the first time a session opens there: the block lives between
  `<!-- kora:begin -->` and `<!-- kora:end -->` (your own text outside the markers is never touched; delete the block
  with `kora enforce uninstall`), the hooks go to `.claude/settings.local.json` (git-ignored via `.git/info/exclude`,
  never your `.gitignore`). Nothing is written into a folder that is not a git project, or into your home folder.
- No graph yet (not indexed, being indexed, incomplete): the brief says grep and Read are the right tools and the
  Grep redirect stands down.

## 6. The graph chip

| Chip                          | Meaning                                                                                 | Action                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Not indexed · Index?          | no index for this checkout                                                              | Index this repo                                                   |
| Indexing 42% / Finalizing…    | an ingest is running (from its job row; Finalizing = linking edges)                     | wait                                                              |
| Fresh / Stale                 | index at HEAD / behind HEAD (re-indexes on the next prompt)                             | Re-index, Full re-index, open the explorer                        |
| Incomplete · Re-index         | the last full index died part-way                                                       | Re-index now                                                      |
| Index failed · Retry          | the last index you started failed (reason in the menu, details in `~/.kora/ingest.log`) | Retry                                                             |
| Graph store damaged · Rebuild | the store file cannot be read                                                           | Rebuild (moves it to `graph.db.damaged-<time>` and indexes again) |
| Folder missing                | the project folder was moved or deleted                                                 | remove and re-add the project                                     |
| (no Index item)               | a home or system folder                                                                 | open a project folder                                             |

## 7. When something looks wrong

1. `kora doctor` — store, this repo's index, freshness, last failed index, enforcement, daemon.
2. `kora graph status` in the repo; `kora ingest .` (incremental) or `kora ingest . --full`.
3. Logs: `~/.kora/ingest.log` (chip-started ingests), `~/.koragraph/catch-up.log` (query-time catch-ups),
   `~/.kora/server.log` (daemon), `~/.kora/inject.jsonl` (injection decisions).
4. Store trouble: `kora graph prune --dry-run`; a damaged store is moved aside automatically by the next ingest.

## 8. Where the code lives

- Engine (vendored Koragraph): `packages/runtime/koragraph` — ingest `src/cli/ingest.js`, `src/services/ingest.js`,
  freshness `src/services/live-freshness.js`, hygiene `src/services/store-hygiene.js`, git hooks
  `src/services/git-hooks.js`. Every behaviour change is listed in `koragraph/PATCHES.md`; regressions in
  `koragraph/test/graph-hardening*.test.js`.
- Kora's layer: `packages/runtime/src/graph/` — `service.ts` (status, scoping, slimming, ingest wrapper, damaged-store
  handling), `prompt-inject.ts` (injection), `offload.ts`/`worker.ts` (queries in worker threads), `embedded.ts`.
- Enforcement: `packages/runtime/src/enforce/` (rulebook blocks, hooks, MCP config), `src/cli/commands/hook.ts`.
- Chip and explorer: `packages/ui-server/src/graph.ts` (`/api/graph/status`, `/api/graph`, `/api/graph/reindex`),
  `apps/web/src/components/thread/GraphStatusChip.tsx`, `apps/web/src/components/graph/`.
