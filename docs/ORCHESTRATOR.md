# The orchestrator

Every Code thread in Kora can delegate. The agent you talk to is the **lead**; the agents it hands work to are
**workers**. This page explains how a piece of work moves through that loop and what keeps it safe and cheap.

## The loop

```
you ──▶ lead ── kora_ask_workers ──▶ you approve the workers (agent · model · effort)
              ── kora_spawn ───────▶ worker panes, each in its own git worktree + branch
              ── kora_wait ────────▶ reports come back (the lead reads only what it needs)
              ── kora_merge_verify ▶ graph-verified gate across the workers' branches
              ── kora_merge ───────▶ branches land in your checkout in a safe order
```

1. **Plan.** For anything that splits, the lead uses the code graph to find the edit sites, the callers whose contract
   changes, and the files a slice must not touch, then publishes a short plan (`kora_plan`) you can see beside the
   chat.
2. **Propose.** `kora_ask_workers` puts one row per task in front of you: which agent, which model, which effort, and
   a one-line reason. The picker is pre-filled; you approve with one click or change any row. Choosing "don't ask again"
   for a thread approves the lead's picks from then on.
3. **Spawn.** `kora_spawn` starts exactly the approved picks, each with a self-contained brief. A worker gets its own
   worktree under `~/.kora/worktrees/<repo>/` on a `kora/<name>` branch, so workers never write over each other or
   over you.
4. **Watch and steer.** Each worker is a live pane. Type into it and the worker gets your words; the lead sees them too.
   Stop one and it stays stopped: the lead is told not to respawn it.
5. **Collect.** `kora_wait` returns each worker's report when it finishes, needs a human, or exits. `kora_read` shows
   what a worker said or what is on its screen right now.
6. **Merge.** `kora_merge_verify` runs the merge gate over the branches and suggests an order; `kora_merge` lands them.

## What the merge gate catches

Git merges text. Two workers can change different lines and still break each other: one renames a function the other
still calls, one changes a signature the other relies on, one deletes a file the other imports. The gate builds the
graph of each branch's changes, compares them with each other and with the base, and reports pairs that collide
semantically even though git would merge them cleanly. It runs in a child process, so a big merge never stalls the app.

`kora merge check <refs…>` runs the same gate from a terminal; `kora pr check` runs it on GitHub pull requests.

## Which agents can do what

| Role   | Claude Code | Codex | OpenCode | Antigravity |
| ------ | :---------: | :---: | :------: | :---------: |
| Lead   |      ✓      |   ✓   |    ✓     |      —      |
| Worker |      ✓      |   ✓   |    ✓     |      ✓      |

A lead can mix workers from different agents in one plan. Workers run either as structured "boxes" (the agent's own
event stream, with tool calls and approvals shown as cards) or as terminal panes for CLIs that only have a terminal UI.

## Stretch: free first

The **Stretch** button in the composer changes how the lead staffs work:

1. **Tier 1: free models.** OpenCode workers on free models (OpenCode Zen, then OpenRouter's free models, then
   Cerebras) take every slice they can. They cost nothing, and they are steerable panes like any other worker. A
   worker that hits a rate limit fails over to the next free model.
2. **Tier 2: cheap paid models.** Only when no free worker is available, or a task failed on every free model, the lead
   proposes Claude Haiku or Codex Luna workers. Stretch approves those picks itself and holds them to those models.

A first-time setup explains what the free providers see (the task text and the files the worker reads) before you turn
it on. Local models through Ollama or LM Studio are supported for workers whose data must stay on the machine.

## No hidden subagents

No agent in Kora starts its harness's own subagents (Claude's Task/Agent tools are disabled, Codex runs with
`--disable multi_agent`). Delegation is always `kora_spawn`: a real CLI in a pane you can see, approved by you. That is
what makes the cost visible and the work steerable.

## Under the hood

- Fleet tools: `packages/runtime/src/session/fleet-tools.ts` (the tool definitions every lead gets),
  `session/worker-picker.ts` (the approval flow).
- Panes, worktrees, the fleet roster and merges: `packages/runtime/src/server/` (`workspace.ts`, `worktree.ts`,
  `driver-pane.ts`, `swarm*.ts`) and `packages/runtime/src/merge/`.
- The fleet panel and worker boxes: `apps/web/src/components/fleet/`, `FleetPanel.tsx`, `components/swarm/`.
