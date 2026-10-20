# Swarm e2e harness

Live end-to-end tests for Swarm mode against an **isolated** daemon (own `KORA_HOME`, socket, UI port 8798,
graph DB), so the real `~/.kora` daemon on :8797 is never touched. Real Claude leaders (the SDK chat lane, your
Claude login — this spends real plan usage) and real OpenCode workers on Zen (no key).

Prereqs: `pnpm build` (runtime dist + ui bundle), OpenCode installed at `~/.kora/tools/opencode/current`
(`kora swarm install`), Node 24 on PATH. Scratch lives in `$SWARM_E2E_DIR` (default `$TMPDIR/kora-swarm-e2e`).

| Script | What |
|---|---|
| `./daemon.sh start\|stop\|status` | isolated daemon (`PROF=1 ./daemon.sh start` → `--cpu-prof` into `<dir>/prof`) |
| `node run.cjs <N> [model] [tag]` | N concurrent leaders, one scratch repo each, 2 independent tasks; writes `results/<tag>/summary.json` (tests pass, files present, swarm tasks/reports, merges) |
| `node scen.cjs midturn\|leave\|restart-a\|restart-b` | edge cases: flip mid-turn, Swarm→Chat with workers, daemon restart mid-swarm (run restart-a, restart the daemon, then restart-b) |
| `node restart-midwait.cjs a` → restart → `node restart-midwait.cjs b` | daemon restart while a Swarm lead sits in kora_spawn/kora_wait; b sends "continue" and reports whether the lead respawned (should be 0 spawns, tests green) |
| `node ask.cjs` | AskUserQuestion in a full-access thread waits for the answer and resolves in-turn |
| `./peek.sh <tag> [n]` | live view of a run's non-delta events + server log tail |
| `python3 prof.py <cpuprofile> [minMs]` | event-loop stalls in a daemon CPU profile, heaviest stacks per stall |
| `KORAGENT_BIN=… node koragent-live.cjs [model] [model2]` | the koragent WorkerBackend against the REAL Koragent through Kora's Runtime (no Claude): every CONTRACT.md point plus the Koragent C4 fixes (K1 catalog JSON, K2 in-session `model.reject` failover to `model2`, K5/K7 report, K3/K4 in a direct `run --task-spec`) → `$TMPDIR/kora-kg-live/result.json`. For a full e2e on Koragent set `swarm.workerBackend: "koragent"` in `<dir>/home/config.json` and `KORAGENT_BIN` in the daemon env (docs/swarm/KORAGENT-INTEGRATION.md) |
| `KORAGENT_DIST=<binary> node kg-restart.cjs` | koragent backend, no Claude: a scripted leader (fleet tools over the socket) spawns 2 tasks, the daemon restarts mid-job; checks finished stays finished, the unfinished one resumes on its pane id with a digest, kora_wait/kora_workers/kora_merge after the restart (installs Koragent into `<dir>/koragent-home` on first run) |
| `node kg-lead.cjs` | a Koragent lead pane (`kora agent spawn koragent -- --lead --prompt …`) dispatching swarm workers: installed binary, `--help` spawns nothing, workers not `supervised`, no permission blocks, merged and green |
| `node kg-claude-restart.cjs [model]` | the restart proof with a real Claude leader (Swarm mode; spends one Claude run) |
| `node kg-e2e3.cjs [model] [tag]` | one Claude leader, 3-bug invoicer, 3 Koragent workers → merge → `node --test` green |
| `node worker-tokens.cjs` | real per-task worker token usage from OpenCode's session DB (cost inputs) |
| `repro-start.cjs` / `repro-daemon.cjs` | record an OpenCode worker's start-up screens + detected states |

Results of the 2026-09-24 runs are summarized in `docs/swarm/STATUS.md`.
