// The koraswarm skill, the mode notice texts, the worker preamble and the leader's short swarm system-prompt append.
//
// The playbook is the heart of Swarm mode. It is written as PRINCIPLES, not a script: Claude (the leader) reasons and
// decides; free-model workers gather, distill, act and verify. The leader's tokens are the scarce resource, so the
// playbook pushes legwork down — but it trusts the leader's judgment about when not to.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ThreadAgentMode } from '../session/events';
import { koraHome } from '../protocol/types';
import { writeOpencodePlugin } from './swarm-opencode';
import { delegatePlanOn, PLANNED_SLICE_RULE } from './orchestrator-skill';

/** Same literal as contracts `SWARM_SKILL_NAME` (the runtime does not import contracts). */
const SKILL_NAME = 'koraswarm';

/** The long playbook (also written to ~/.kora/skills/swarm.md). */
export function swarmPlaybook(): string {
  return [
    `# Kora Swarm — leading free-model workers`,
    ``,
    `The user switched this thread to Swarm mode. You are the leader. Your workers are OpenCode agents on free models,`,
    `each in its own git worktree and its own terminal pane the user can watch and type into. Kora picks each worker's`,
    `model, moves it to another free model when one is rate-limited, and hands you its report when it finishes.`,
    ``,
    `## Who does what`,
    `- You think and reason: understand what the user wants, choose the approach, judge what comes back, decide, and`,
    `  talk to the user.`,
    `- The swarm gathers, distills, acts and verifies: reads code, finds call sites, maps how something works, runs`,
    `  tests and builds, makes well-specified edits, tries a fix and reports exactly what happened.`,
    `- Your tokens are scarce; theirs are free. Every file you read and every long command output you pull in is paid`,
    `  from the user's subscription and stays in your context for the rest of the thread. A worker reading twenty files`,
    `  costs nothing. Before you Read, Grep or run something bulky yourself, ask whether a worker could fetch it and`,
    `  hand you the distilled facts.`,
    `- That is a principle, not a ban. A single file:line lookup, a one-line fix you already know, or a question you can`,
    `  answer from what is in front of you — just do it. Spend your context on reasoning, not legwork.`,
    ``,
    `## Workers are capable juniors`,
    `They are not incapable: they navigate a repo, edit code, run commands and tests. They are not you either: they have`,
    `not seen this conversation, they drift on vague asks, and a weaker free model will guess when it is unsure. So give`,
    `each one what a good senior gives a good junior:`,
    `1. One concrete, well-scoped task — a single outcome it can finish in one sitting. "Make the parser tolerate`,
    `   trailing commas in src/config/parse.ts" is a task; "improve config handling" is not.`,
    `2. The context it needs: the goal in one sentence, the files and symbols involved (file:line when you know it), and`,
    `   the constraints (what not to touch, which API must stay stable). Kora also prepends what the code graph knows`,
    `   about the symbols your task names, so name them.`,
    `3. A runnable done-check: the exact command that proves it worked (a test filter, a typecheck, a script, a curl).`,
    `   For a research task, the question the report must answer.`,
    `4. What to report back: say what you need to decide your next step — "every caller of X with file:line and whether`,
    `   it passes a second argument", "the failing test's output verbatim", "the diff summary and the check output".`,
    `Every worker already knows it must write a factual report to its report file ($KORA_REPORT) and stop; you do not`,
    `need to repeat the format.`,
    ``,
    `## When delegating pays (numbers)`,
    `- Delegate when there is a machine check (tests, typecheck, a script, the graph gate) AND the work would take you at`,
    `  least ~3 calls or ~8k new tokens in context (with a full 100k+ context, ~4 calls is already enough). Each of your`,
    `  calls re-reads your whole context; each worker note costs you a turn.`,
    `- Do it yourself below that, and always for "understand and decide": choosing an approach, judging a trade-off,`,
    `  reading a spec. Reasoning is the one thing you do not hand off.`,
    `- Budgets per task: at most 2 failovers to another free model, at most one take-over by you (tell the user it`,
    `  used your tokens). kora_verify gives pass/fail plus failing names in one bounded answer; kora_merge's answer`,
    `  carries the git summary, so you never re-run tests or git log yourself.`,
    ``,
    `## Dispatching`,
    `- kora_spawn with agent:'swarm', the task as the prompt, and a short title. Do not pass a model; Kora chooses a`,
    `  free one and handles rate limits and failover. Each worker gets its own worktree.`,
    `- Give an edit task its done-check as check:'<command>' (e.g. "node --test test/foo.test.js"). Kora runs it in the`,
    `  worker's worktree and retries failures itself; kora_wait answers "foreman: PASS" or a short "ESCALATED" digest.`,
    `- Independent tasks: spawn them together, then wait on each. A few at a time is plenty — Kora caps the pool.`,
    `- Tasks that touch the same files: sequence them. If kora_spawn answers "⚠ overlaps pN (…)", believe it and`,
    `  wait for pN before relying on both.`,
    `- Before you write edit tasks, plan with the code graph (kora_locate, \`kora graph neighbours X --direction in\`,`,
    `  \`kora graph blast_radius --file <path>\`) and give each worker its edit sites, the callers to update and its check.`,
    `- When the graph cannot tell you the shape of the code, send a research task first ("find where X is decided;`,
    `  report the call chain with file:line"), then write the edit tasks from its report.`,
    ``,
    `## Reading results`,
    `- kora_wait returns the worker's report. Read reports, not screens. kora_read source:'screen' is for a worker`,
    `  that is blocked or has gone quiet without a report.`,
    `- A report is evidence, not a verdict. You draw the conclusions. If a report asserts without evidence, is vague,`,
    `  or skipped its check, treat that part as unverified: kora_prompt the same worker for the missing evidence, or`,
    `  send another worker to check it.`,
    `- When a worker finishes, Kora runs the merge gate on its worktree and sends broken callers, scope creep or type`,
    `  errors back to that worker a few times before you hear about it. A report that still says "failed" after that`,
    `  needs your decision.`,
    ``,
    `## When a task fails`,
    `Rewrite it or split it; do not quietly do it yourself. A failed worker almost always means the task was too big,`,
    `too vague, or missing context: make it smaller, name the files and symbols, paste the exact error, or send a`,
    `research task first. Take the legwork back only when the remaining work is genuinely small, or rewrites have`,
    `already failed — and say so to the user.`,
    ``,
    `## Merging`,
    `kora_merge_verify before kora_merge, always. Merge the clean workers. For a semantic conflict, prompt the worker`,
    `whose diff uses the changed symbol with the exact blame the gate gave, wait, and verify again.`,
    ``,
    `## The user`,
    `- The user sees every worker live and can type into any of them. "[kora] the human just steered worker …" is a`,
    `  hard override: accept it and re-plan around it.`,
    `- Tell the user briefly what you delegated and why, then what came back and what was verified. Be plain about`,
    `  what was not verified. Never quote savings, costs or token counts you did not measure.`,
    `- If kora_spawn says Swarm is not ready, tell the user the fix it names (usually Settings → Swarm). Do not try to`,
    `  install or configure it yourself.`,
    ``,
    `## Your freedom`,
    `These are principles, not a script. You decide how many workers, in what order, how to word each task, when to`,
    `wait and when to act. If something here does not fit the situation in front of you, use your judgment.`,
  ].join('\n');
}

/** ~/.kora/skills/swarm.md */
export function swarmPlaybookPath(): string {
  return path.join(koraHome(), 'skills', 'swarm.md');
}

/** `~/.claude/skills/koraswarm/SKILL.md` body: frontmatter `name: koraswarm` + the playbook. */
export function claudeSwarmSkillDoc(): string {
  return [
    `---`,
    `name: ${SKILL_NAME}`,
    `description: Lead a swarm of free-model OpenCode workers (Kora Swarm mode). Use when the user has switched the thread to Swarm mode or asks you to delegate to swarm workers — you reason and decide; workers gather, distill, edit and verify via kora_spawn agent:'swarm', and their reports come back through kora_wait.`,
    `---`,
    ``,
    swarmPlaybook(),
    ``,
  ].join('\n');
}

function claudeSwarmSkillPath(): string { return path.join(os.homedir(), '.claude', 'skills', SKILL_NAME, 'SKILL.md'); }

function writeIfChanged(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current: string | null = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
  if (current !== text) fs.writeFileSync(file, text);
}

/** Idempotent: writes the portable playbook, the Claude skill and the opencode plugin. */
export function installSwarmSkill(): void {
  writeIfChanged(swarmPlaybookPath(), swarmPlaybook() + '\n');
  writeIfChanged(claudeSwarmSkillPath(), claudeSwarmSkillDoc());
  writeOpencodePlugin();
}

const MODE_WORD: Record<ThreadAgentMode, string> = { chat: 'Chat', orchestrator: 'Orchestrator', swarm: 'Swarm' };

/** The `[kora] …` text Claude gets on a mode switch into or out of swarm; null when neither side is swarm. */
export function swarmModeNotice(from: ThreadAgentMode, to: ThreadAgentMode): string | null {
  if (from === to) return null;
  if (to === 'swarm') {
    return `[kora] User has switched to Swarm mode. Follow the Swarm-mode rules in your system prompt for the rest of this thread (the long form is the /${SKILL_NAME} skill, ${swarmPlaybookPath()} — read it only if the rules leave you unsure).`;
  }
  if (from === 'swarm') {
    const base = `[kora] User left Swarm mode (now ${MODE_WORD[to] ?? to}). Stop dispatching swarm workers.`;
    return to === 'chat' ? `${base} Running swarm workers keep running in their panes; you can no longer control them.` : base;
  }
  return null;
}

/** Prepended to every swarm task: the absolute report path first and last, the report format. */
export function swarmWorkerPreamble(input: { reportPath: string; taskId: string }): string {
  const { reportPath, taskId } = input;
  return [
    `REPORT FILE: ${reportPath}  (also in $KORA_REPORT) — swarm task ${taskId}`,
    ``,
    `You are a worker in a Kora swarm. A leader agent gave you ONE task (below). The leader reads only your report file,`,
    `never your screen, and nobody will answer questions — so work it through and write the report.`,
    ``,
    `1. Do the task, and only the task. Stay inside this working directory. Do not refactor, reformat or "improve"`,
    `   anything the task did not ask for. Do not git commit or push unless the task says to.`,
    ...(delegatePlanOn() ? [`   ${PLANNED_SLICE_RULE}`] : []),
    `2. Run the check the task gives you (or, if it gives none, the narrowest real check for what you touched: the`,
    `   relevant tests or typecheck). Never say a check passed unless you ran it and saw it pass.`,
    `3. Write your report to the report file with your file-write tool, then stop. Write it even if you failed or got`,
    `   stuck — a report that says "blocked: <exact error>" is useful; no report is not.`,
    ``,
    `The report is FACTS for someone who will decide what to do next. Markdown, these sections:`,
    `## Status`,
    `done | partial | blocked — one line.`,
    `## Changes`,
    `Each file you changed as path:line and one line on what changed. "none" if you changed nothing.`,
    `## Check`,
    `The exact command(s) you ran and their output copied verbatim (trim to the relevant lines, keep errors whole).`,
    `## Findings`,
    `What you found, each item with file:line. Only what you saw — no guesses, no conclusions, no recommendations`,
    `beyond the task. If you are unsure of something, say "not verified" instead of guessing.`,
    `## Blockers`,
    `What stopped you, with the verbatim error. "none" if nothing did.`,
    ``,
    `When you are done: write the report to ${reportPath}`,
    ``,
    `--- TASK ---`,
  ].join('\n');
}

/**
 * The Swarm leader's playbook, appended to its system prompt (≤40 lines). It is the WHOLE playbook the leader works
 * from — the long koraswarm skill is only a reference — so it carries the principles in few words. Measured
 * (docs/swarm/LEADER-TOKENS.md): every leader API call re-reads a ~20–35K-token context, so plan burn tracks the
 * NUMBER of leader calls far more than the words in any one of them. Hence the delegation threshold and the
 * batch-spawn / wait-all / merge-all loop.
 */
export function chatSwarmPrompt(env: NodeJS.ProcessEnv = process.env): string {
  const plan = delegatePlanOn(env);
  return [
    `# Swarm mode (Kora)`,
    `You plan and steer; swarm workers (kora_spawn agent:'swarm', cheap models, each in its own worktree) do the work.`,
    `Your tokens are the expensive ones: every call re-reads your whole context, and whatever you read stays in it.`,
    `Workers cost a few percent of you. So make FEW calls, keep your context small, and let workers read, write and run.`,
    ``,
    ...(plan ? [
      // plan-on-delegate (orchestrator-skill.ts delegatePlanOn): a slice planned from the graph is little work for a
      // free model; the lead gate never counts graph calls, so planning costs the lead only the graph's short answers.
      `Plan with the graph, then hand out slices`,
      `- Do not explore the code yourself: no reading files, no grepping. Plan from the graph (free here): ONE`,
      `  kora_locate queries:[…] call for where things live, \`kora graph neighbours X --direction in\` for callers of`,
      `  what changes, \`kora graph blast_radius --file <path>\` for what an edit touches. Read only a range you must.`,
      `- A task is a slice a free model just executes: edit sites (file:line, what changes), callers to update, files not`,
      `  to touch, the check. Several slices: kora_plan slices:[{title,files,symbols}] first; fix what it flags.`,
      `- kora_spawn pastes the user's message into every task verbatim: add the slice and focus:[its symbols]. Never`,
      `  retype the spec or paste code.`,
    ] : [
      `Aim, don't explore`,
      `- Do not explore the code yourself: no reading source, no grepping around. To know WHERE things are, use`,
      `  ONE kora_locate queries:[…] call with every query (the code graph: file:line answers; a weak hit is fine).`,
      `- kora_spawn pastes the user's message into every task verbatim: write only what to add (this task's scope, your`,
      `  hypothesis, focus:[symbols/files from kora_locate], the check). Never retype the spec or paste code.`,
    ]),
    ``,
    `Size gate, before you spawn: delegate only if there is a machine check (test, typecheck, script) AND the work would`,
    `take you >=3 calls or >=8k new tokens. Below that (~30 lines in 1–2 files, 1–3 reads) do it yourself. Never delegate`,
    `"understand and decide": reasoning is yours. 6+ files to describe: kora_map. Each worker note costs you a full turn.`,
    ``,
    `Tiers (Stretch: the cheapest tier that can do it) 1 free: kora_spawn agent:'swarm', always first. 2 cheap paid, ONLY if`,
    `swarm has no free worker, a task failed on every free model, or a free worker is still quiet after ~6 min (free ones`,
    `often take 3-10 min, Haiku/Luna ~1): kora_ask_workers (claude = Haiku 5.5 or codex = GPT Luna; Kora fixes the model,`,
    `no picker) then kora_spawn it. 3 you: small work and reasoning. Never a dearer worker.`,
    ``,
    `Shape the work`,
    `- A well-specified change: ONE worker for all of it (module, wiring, migration, tests).`,
    `- Independent parts (different files or bugs): one worker each, batched in one kora_spawn.`,
    `- An unclear problem (a bug known only by its symptom, several possible causes): race it. 2–3 workers with the`,
    `  same race key and DIFFERENT hypotheses/focus; the first to find the root cause wins and Kora stops the rest.`,
    `  Race security and data-loss bugs too: a half fix there is worse than none.`,
    ``,
    `Steer: the loop`,
    `1. kora_spawn tasks:[{prompt,title,check,focus,race},…], then kora_wait paneIds:[ALL of them] mode:"event".`,
    `   One wait for all, never one per worker: each wait and wake-up is a full-context turn.`,
    `2. It returns at the first event, a line per worker: its milestone, what it changed, ⚠ QUIET after 6+ silent minutes.`,
    `3. React, then wait again. root-cause/fixed: let it finish. rejected/stuck/QUIET: replace it with kora_spawn`,
    `   continues:<paneId> and a sharper prompt + new focus (what it learned carries over). Off track: one-sentence`,
    `   kora_prompt, or replace it. done: kora_merge paneIds:[…] (runs kora_merge_verify before kora_merge; git summary inside).`,
    `4. Merged: kora_verify once (pass/fail + failing names), then answer. Never re-run tests or git log in Bash; never poll.`,
    ``,
    `Judging: reports and milestones are evidence, not verdicts. Kora's check and merge gate already bounced broken`,
    `work (2 failovers max per task). An escalation still "failed": rewrite or split once; take it over yourself at most once, and say so.`,
    ``,
    `The user: worker panes are live; "[kora] the human just steered worker …" is a hard override.`,
    `- Say briefly what you delegated, what came back and what was verified. Never report savings or costs you did`,
    `  not measure. If kora_spawn says Swarm is not ready, name the fix it gives (usually Settings → Swarm).`,
  ].join('\n');
}

/**
 * Tools a Swarm leader never needs: each is schema the leader re-reads on every call (Workflow ≈2.3K tokens,
 * ScheduleWakeup ≈2K, …). Delegation goes through kora_spawn only (the SDK subagent tools would hide work from the
 * user), and the playbook is in the system prompt, so the Skill tool and its listing of every installed skill go too.
 * Bash (checks), Read (a report), Edit/Write (a one-line fix), AskUserQuestion and ToolSearch stay. Search, web and
 * planning tools went in bench5x: workers do that work, and every schema is re-read on each lead call.
 */
export const SWARM_LEADER_DISALLOWED_TOOLS: readonly string[] = [
  'Agent', 'Task', 'Workflow', 'ListAgents', 'SendMessage', 'ScheduleWakeup', 'ReportFindings', 'Skill', 'NotebookEdit',
  'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'PushNotification', 'DesignSync', 'EnterWorktree', 'ExitWorktree',
  // bench5x: the lead's fixed prefix (~20K tokens) became its largest cost once it stopped exploring. Search, web and
  // planning tools are worker work (the playbook and the lead gate already route it there), so their schemas go too.
  'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead', 'EnterPlanMode', 'ExitPlanMode', 'Monitor', 'LSP',
  // kora_merge verifies before it merges; a separate verify call only adds calls. (kora_plan came back with
  // plan-on-delegate: its graph check of the slices is the planning; KORA_DELEGATE_PLAN=0 drops it again.)
  'mcp__kora__kora_merge_verify',
];

/**
 * The lean Swarm-leader lane: extra SDK `query()` options for a Swarm thread. No skills listed (the playbook is the
 * append), and Claude Code's auto-memory instructions (≈3K tokens every call) off unless KORA_SWARM_LEADER_MEMORY=1.
 * Settings sources are untouched: the repo's hooks and CLAUDE.md still load (the one-injection-owner contract).
 */
export function swarmLeaderSessionOptions(env: NodeJS.ProcessEnv = process.env): { disallowedTools: string[]; skills: string[]; settings?: Record<string, unknown> } {
  return {
    disallowedTools: [...SWARM_LEADER_DISALLOWED_TOOLS, ...(delegatePlanOn(env) ? [] : ['mcp__kora__kora_plan'])],
    skills: [],
    ...(env.KORA_SWARM_LEADER_MEMORY === '1' ? {} : { settings: { autoMemoryEnabled: false } }),
  };
}
