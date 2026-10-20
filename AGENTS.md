# Working on Kora

Guidance for anyone changing this repository, human or agent. `CLAUDE.md` and `GEMINI.md` point here.

Kora is a macOS desktop app that runs coding agents (Claude Code, Codex, OpenCode, Antigravity) as an orchestrated
fleet: a lead agent plans and delegates, workers run in their own git worktrees in live panes you can watch and steer,
and a local code graph keeps every agent's context small. Everything runs on the user's Mac; there is no Kora account
and no cloud service.

## Layout

```
apps/desktop            Electron shell (main + preload). Connects to the daemon on 127.0.0.1:8797, serves the web
                        build over the kora:// protocol, owns native menus and self-update.
apps/web                React client: threads, composer, tool cards, fleet panel, graph explorer, settings.
packages/runtime        The `kora` CLI and daemon: agent sessions (src/session), worker panes, worktrees, fleet and
                        merge gate (src/server), the code graph and prompt injection (src/graph), hooks (src/enforce).
packages/runtime/koragraph   The code-graph engine (ingest, SQLite store, queries). Engine changes: list them in
                        koragraph/PATCHES.md and add a regression under koragraph/test/.
packages/ui-server      The UI protocol server (Effect RPC over /ws and /api/*). Runs inside the daemon: bundled to
                        packages/runtime/ui/ui-server.cjs and loaded by packages/runtime/src/server/ui.ts.
packages/contracts      Wire schemas shared by daemon and client (the RPC group, desktop IPC).
packages/client-runtime Client state and the wire connection, independent of React.
packages/shared         Small shared utilities.
packages/oxlint-plugin-kora   Repository lint rules.
qa/                     Playwright UI regression suite on isolated daemons (see qa/README.md).
scripts/                build, start, dev, packaging, icons.
```

One daemon per machine: `kora server run` serves a unix socket at `~/.kora/kora.sock` (CLI, hooks, workers) and the UI
API on `127.0.0.1:8797`. State lives in `~/.kora`; the graph store is `~/.koragraph/graph.db`.

## Commands

Node 24 (`^24.11.1`) and pnpm 11.

```sh
pnpm install
pnpm build            # runtime (tsc) → ui-server bundle → web → desktop
pnpm start            # the desktop app from this checkout (starts the daemon if needed)
pnpm dev              # same, web client hot-reloading from Vite
pnpm typecheck
pnpm test             # every workspace; the runtime suite needs macOS
pnpm lint && pnpm fmt:check
pnpm canary           # prompt-injection canary against an indexed repo
pnpm app:package      # self-contained dist/Kora.app
```

Runtime or ui-server changes need a daemon restart: `kora server stop && kora server start`.

## Rules that matter

- **Wire values.** Every value sent to the client goes through `toJsonValue` (packages/ui-server). A nested `undefined`
  kills the JSON RPC stream and the UI hangs on "syncing"; schema checks do not catch it. `Schema.DateTimeUtc` fields
  need a real `DateTime`, not an ISO string.
- **The daemon's event loop.** A stall of a few seconds drops the UI WebSocket. Heavy work (graph ingest, catch-up,
  merge gates) runs in child processes, and git is never called synchronously on the event loop. The stall detector
  in daemon.ts logs every stall.
- **Wasm grammars need `node --liftoff-only`.** V8's optimizing wasm tier crashes on some tree-sitter grammars; every
  ingest child and the daemon pass the flag. A new process that parses code must too.
- **Folder trust.** Until the user trusts a folder, agents run without its project config and Kora answers none of
  their trust or MCP prompts. Any new agent lane or spawn path goes through `packages/runtime/src/trust/gate.ts`.
- **One injection owner.** The SDK lane sets `KORA_INJECT_OWNER=driver` so the prompt hook leaves graph injection to
  the Claude driver. Break either side and the savings silently vanish; `pnpm canary` catches it.
- **Native modules** (better-sqlite3, node-pty) must match the Node that runs the daemon.
- **The client must work without the Electron bridge** (`window.shellBridge`): the QA suite runs in a plain browser.
  Anything that needs it shows a visible fallback.
- **Design.** Dark only, flat, monochrome: true-black ground, `#f2f2f4` text, 7% white hairlines, no accent hue, no
  gradients or shadows. `apps/web/src/designTokens.test.ts` enforces contrast and the palette.
- Never kill processes by name pattern: stop the daemon with `kora server stop`, an app by its exact PID.

## Delegation inside Kora

No agent in Kora starts its harness's own subagents. Delegation is `kora_spawn` only: a real CLI worker in a pane,
picked by the user from the lead's proposal (`kora_ask_workers`). See docs/ORCHESTRATOR.md.

## Pull requests

Small and focused, with tests for behaviour changes. Run `pnpm typecheck && pnpm test && pnpm lint` before pushing.
See CONTRIBUTING.md.
