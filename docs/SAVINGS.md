# Where the savings come from

Kora's savings are measured on real usage and real benchmarks, and the in-app meter books wins only (it never nets a
saving against a lever that cost more somewhere else, and it says so). This page lists what each lever does, what we
measured, and the levers we measured and chose **not** to turn on.

## Where agent money actually goes

From fourteen days of one heavy user's real sessions, priced at list price:

- **Lead threads are most of the bill** (about 85% of spend). A typical lead thread makes hundreds of calls and its
  context peaks well over 300k tokens.
- **The bill is re-reading.** About 96% of tokens are cache reads: every call re-reads the whole conversation. Thinking
  is around 5% of the cost.
- **A lead's own tool calls are most of a lead's cost** (about 80%): each Bash, Read or Edit is answered inside the
  lead's large context. The fleet tools themselves are under 10%.
- **The fixed prefix matters.** A worker pane re-reads roughly 40k tokens of tool definitions, skill listings and memory
  on every call before doing any work.

So the levers that move real money are, in order: which model does the work, how big the context gets, and where each
command runs. Compressing tool output is a small lever.

## The levers

### Where the work runs

| Lever                      | What it does                                                                                                                                                                                                                                      | Default                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Price-aware worker picks   | The lead is told the relative price of each model and suggests the cheapest that can do a slice (bounded, planned slices on small models; ordinary coding on mid-tier; the largest models only for hard reasoning). You still approve every pick. | on                     |
| Free workers (Stretch)     | OpenCode workers on free models take every slice they can; that slice's paid usage is zero.                                                                                                                                                       | button in the composer |
| Lean worker panes          | Worker panes start without the full skill listing, prompt suggestions and tools they never use.                                                                                                                                                   | on                     |
| Hand long runs to a worker | The lead is told that five or more commands for one step are far cheaper in a fresh worker. A replay of real lead threads put the saving near half of the lead loop, but it has not been benchmarked on whole runs, so it is off.                 | off                    |

### What the agent reads

| Lever                  | What it does                                                                                                                                                                                                   | Default |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Declarations up front  | A code-shaped prompt gets the matching declarations (file and line, and the body of a small top hit) before the agent starts searching.                                                                        | on      |
| Search redirect        | A cold search for a code identifier (the Grep tool, or one recursive `rg`/`grep`) is denied once and pointed at the graph; text searches always pass.                                                          | on      |
| Quiet search shim      | In worker panes, `grep`/`rg` for one identifier prints only the graph entries that declare it. Replay: 95,049 → 2,822 characters of output over 162 searches.                                                  | on      |
| Read dedupe            | A second read of an unchanged file is nudged; a changed file gets only the changed ranges; a whole-file read of a long file is nudged toward a range.                                                          | on      |
| Worktree-aware answers | In a worker's worktree, graph answers for files the branch changed are re-read from the branch, so the worker does not Read to double-check. Measured on worktree tasks: one call instead of two, 26% cheaper. | on      |

### How big the context gets

| Lever                         | What it does                                                                                                                                   | Default                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Earlier compaction            | Kora-started Claude sessions compact at about 167k tokens instead of near the 1M window's limit.                                               | on (Settings › Defaults) |
| Output trim                   | A command output over 8,000 characters becomes its head, its error lines and its tail; the full text is kept in a file the agent can open.     | on                       |
| Side calls on the small model | Claude Code's background calls (titles, summaries) run on the current small model instead of an older, pricier one: about 5% of a typical run. | on                       |

### Your plan's limits

| Lever                  | What it does                                                                                                                                               | Default |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Plan meters            | Usage of your Claude, Codex and Antigravity plans side by side, with reset times.                                                                          | on      |
| Stretch near the limit | When a plan window passes 85%, a new thread doing ordinary work starts on a mid-tier model instead of the largest one. A running thread is never switched. | on      |

## Measured and not shipped (or shipped off)

- **Picking a cheaper model per prompt automatically.** On real long threads it saved almost nothing: light first
  prompts grow into real work, and moving a thread up re-writes its whole context at the new price. It is available as
  "Auto model" in Settings › Token savings, off by default.
- **A per-turn advisor model.** One consult cost more than it saved on a large context.
- **Keeping a chat's cache warm between turns.** It would need to replay requests with the user's login, which a
  provider's terms do not allow for a third-party app. Off, and offered only for API-key accounts.
- **Switching models mid-thread to save money.** A model switch re-reads the whole context at the new model's price.
  Kora picks the model at the start of a thread and leaves it.

## How it is measured

- `kora savings` shows real token usage per pane or transcript.
- `kora bench` A/B-tests a task in plain Claude Code against the same task inside Kora, with cost taken from Claude's
  own usage reports; `kora bench --gate` fails on a savings regression.
- `pnpm canary` checks, without spending tokens, that every lane still injects declarations.
- The meter's ledger lives in `packages/runtime/src/ledger/`.
