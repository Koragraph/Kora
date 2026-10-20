// Per-agent adapter: the one place the agent-specific behavior the orchestrator depends on is localized, so
// Codex (and later others) are first-class workers instead of the runtime special-casing `p.agent === 'claude'`.
// Three seams only, each a thing that genuinely differs per agent:
//   - canCompact:  does the agent understand a Claude-style /compact (context compaction) command?
//   - autoAnswer:  given a blocked screen, the key plan to auto-answer a KNOWN-SAFE runtime dialog, or null.
//   - spawnEnv:    per-account credential-isolation env for a spawned pane (a scoped config dir), or {}.
// Detection (which screen an agent is on) is manifest-driven elsewhere; this module never detects, it decides.
import path from 'node:path';
import type { AgentId } from '../protocol/types';
import { koraHome } from '../protocol/types';
import { ClaudeAccounts } from '../session/claude-accounts';

const claudeAccounts = new ClaudeAccounts();
import { planAutoAnswer, isUnder, KEY_UP, KEY_DOWN, KEY_ENTER } from '../server/autoanswer';

// AutoAnswerCtx is structurally the AutoAnswerInput that planAutoAnswer already consumes; keeping a local name
// (rather than re-exporting) documents the adapter contract, and the claude adapter passes it straight through.
export interface AutoAnswerCtx {
  screen: string;
  cwd: string;
  mainRoot: string | null;
  trustedRoots: string[];
  policy: { trustFolder: boolean; mcpFound: boolean; readOutsideWorktree: boolean };
  // allowlist worker-permission mode: also auto-accept an in-worktree FILE EDIT approval (never a command/exec).
  allowEdits?: boolean;
}
/** A sequence of keystrokes the Runtime injects (with pacing) to answer a dialog, plus a human-readable audit line. */
export interface KeyPlan { kind: string; detail: string; keys: string[]; }

export interface AgentAdapter {
  id: AgentId;
  /** true if this agent supports Claude-style /compact. */
  canCompact: boolean;
  /** Given a blocked screen, the key plan to auto-answer a known-safe dialog, or null to leave it for a human. */
  autoAnswer(ctx: AutoAnswerCtx): KeyPlan | null;
  /** Per-account credential-isolation env for a spawned pane (e.g. a scoped config dir). {} when none. */
  spawnEnv(paneId: string, account: string | null): Record<string, string>;
  /** Extra argv to launch this agent with ALL tool-permission prompts disabled (workerPermission='auto'). [] if unknown. */
  skipPermissionArgs(): string[];
  /** Extra argv so file EDITS are auto-approved but commands still prompt (the chat's auto-accept-edits posture). [] if unknown. */
  acceptEditsArgs(): string[];
  /** Extra argv selecting a model / reasoning effort for THIS agent's CLI. Unknown knobs are dropped, never passed blind. */
  modelArgs(model?: string, effort?: string): string[];
}

const underAny = (p: string, roots: string[]) => roots.some((r) => r && isUnder(p, r));

// A numbered option list (❯ / › / > cursor). Used generically to accept a "Yes" option in an approval dialog.
function parseNumberedOptions(screen: string): { index: number; text: string; selected: boolean }[] {
  const out: { index: number; text: string; selected: boolean }[] = [];
  for (const raw of screen.split('\n')) {
    const line = raw.replace(/[│┃|]/g, ' ').trim();
    const m = /^([❯›>])?\s*(\d+)[.)]\s+(.*\S)$/.exec(line);
    if (!m) continue;
    out.push({ index: out.length, text: m[3].trim(), selected: !!m[1] });
  }
  return out;
}
// The plain affirmative option ("Yes" / "Accept"), NOT a "yes and allow ALL / always / auto" broadening.
const isPlainYes = (t: string) => /^(?:yes|accept|approve|confirm)\b/i.test(t) && !/\ball\b|always|auto|every|future|don'?t ask/i.test(t);
/** Keys to select the plain-Yes option in a numbered approval, or null if there isn't a clean one. */
function acceptEditPlan(screen: string, detail: string): KeyPlan | null {
  const opts = parseNumberedOptions(screen);
  const yes = opts.find((o) => isPlainYes(o.text));
  if (!yes) return null;
  const cur = opts.find((o) => o.selected)?.index ?? 0;
  const delta = yes.index - cur;
  const moves = delta > 0 ? Array(delta).fill(KEY_DOWN) : Array(-delta).fill(KEY_UP);
  return { kind: 'editApproval', detail, keys: [...moves, KEY_ENTER] };
}
// A FILE-EDIT approval (safe to auto-accept under allowlist) vs a COMMAND/exec approval (never — always a human's call).
const EDIT_APPROVAL = /make this edit|do you want to (?:create|edit|write|make)|accept this (?:file )?edit|apply (?:this )?(?:edit|patch|change)|edit file|create file|write (?:to )?file/i;
const COMMAND_APPROVAL = /\bbash\(|allow command|run (?:this )?command|do you want to run|execute (?:this )?command|shell command|command to run/i;
const isEditApproval = (screen: string): boolean => EDIT_APPROVAL.test(screen) && !COMMAND_APPROVAL.test(screen);

// ── claude ────────────────────────────────────────────────────────────────────────────────────────────────
// autoAnswer delegates verbatim to planAutoAnswer — the trust-folder / new-MCP-server / read-outside-worktree
// logic lives there and is not duplicated. AutoAnswerCtx is assignable to its AutoAnswerInput, and its
// AutoAnswerPlan (kind is a string-literal union) is assignable to KeyPlan.
const claudeAdapter: AgentAdapter = {
  id: 'claude',
  canCompact: true,
  autoAnswer: (ctx) => {
    const p = planAutoAnswer(ctx);
    if (p) return p;
    // allowlist: accept an in-worktree file edit ("Do you want to make this edit to X?"), never a Bash command.
    if (ctx.allowEdits && isEditApproval(ctx.screen)) return acceptEditPlan(ctx.screen, 'accept file edit');
    return null;
  },
  // registered accounts (Settings > Engines) may adopt any folder; an unregistered name keeps <KORA_HOME>/accounts/claude/<name>
  spawnEnv: (_paneId, account): Record<string, string> => claudeAccounts.env(account),
  skipPermissionArgs: () => ['--dangerously-skip-permissions'],
  acceptEditsArgs: () => ['--permission-mode', 'acceptEdits'],
  modelArgs: (model, effort) => [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])],
};

// ── codex ─────────────────────────────────────────────────────────────────────────────────────────────────
// Codex has no /compact. Its per-account isolation knob is CODEX_HOME (its ~/.codex equivalent).
//
// autoAnswer is deliberately MINIMAL and conservative. Codex's `›` is its INPUT prompt marker (the line the
// user types on — see CODEX_BLOCKED in src/detect/detect.test.ts), NOT a selection cursor, so a blind Enter is
// especially dangerous. The ONLY case we auto-answer mirrors the one Claude runtime-about-itself flag that has
// a clean Codex analogue:
//
//   • trustFolder — Codex's first-run "trust this folder" prompt. Real shape (version-controlled dir):
//       You are running Codex in /Users/me/Projects/app
//       Since this folder is version controlled, you may wish to allow Codex to work in this folder
//       without asking for approval.
//       ❯ 1. Yes, allow Codex to work in this folder without asking for approval
//         2. No, ask me to approve edits and commands
//     Matched ONLY when policy.trustFolder is set AND the cwd is under a configured trusted root, exactly like
//     the Claude trust dialog. We pick the numbered "Yes … work in this folder" option, counting moves from
//     whichever option is cursor-marked (❯ / › / >), defaulting to the first when none is marked.
//
// Everything else is left to a human by returning null, on purpose:
//   • Command / "Allow command?" / apply-patch / edit / run approvals — the agent asking to change the world
//     (the Bash-prompt analogue Claude also never answers). See CODEX_BLOCKED: "Allow command? / npm test /
//     Press enter to confirm" — confirming would run the command.
//   • MCP-server and read-outside prompts — no verified Codex shape; unsafe to guess.
//   • Any screen whose option layout we can't read cleanly.
// Bias-to-null throughout: a wrong keystroke into a live agent is worse than leaving a prompt for a human.

// A command/edit/patch/run approval — the world-changing kind we must never auto-confirm.
const CODEX_WORLD_CHANGING = /allow command|allow codex to run|\brun command\b|apply[_ ]?patch|\bedit file\b|\bwrite file\b|shell command|command to run/i;
// The trust-folder prompt, phrased across Codex versions.
const CODEX_TRUST = /work in this (?:folder|directory) without asking|allow codex to work in this (?:folder|directory)|trust (?:the (?:files|contents) (?:in|of) )?this (?:folder|directory)/i;

interface CodexOption { index: number; text: string; selected: boolean }
/** Parse a Codex numbered option list, flagging the cursor-marked row (❯ / › / >). */
function parseCodexOptions(screen: string): CodexOption[] {
  const out: CodexOption[] = [];
  for (const raw of screen.split('\n')) {
    const line = raw.replace(/[│┃|]/g, ' ').trim();
    const m = /^([❯›>])?\s*(\d+)\.\s+(.*\S)$/.exec(line);
    if (!m) continue;
    out.push({ index: out.length, text: m[3].trim(), selected: !!m[1] });
  }
  return out;
}

const codexAdapter: AgentAdapter = {
  id: 'codex',
  canCompact: false,
  autoAnswer: (ctx) => {
    const s = ctx.screen;
    if (CODEX_WORLD_CHANGING.test(s)) return null;        // agent asking to act — always a human's call
    const flat = s.replace(/[│┃|]/g, ' ').replace(/\s+/g, ' ');
    if (!(ctx.policy.trustFolder && CODEX_TRUST.test(flat))) return null;
    if (!underAny(ctx.cwd, ctx.trustedRoots)) return null; // only inside a declared-trusted root
    const options = parseCodexOptions(s);
    // The grant is the "Yes …" option that is specifically about working in the folder — never a generic
    // "Yes, and don't ask again for <command>" that a command prompt might show.
    const target = options.find((o) => /^yes\b/i.test(o.text) && /folder|directory|without asking|approval|continue/i.test(o.text));
    if (!target) return null;
    const cur = options.find((o) => o.selected)?.index ?? 0; // Codex highlights the first option by default
    const delta = target.index - cur;
    const moves = delta > 0 ? Array(delta).fill(KEY_DOWN) : Array(-delta).fill(KEY_UP);
    return { kind: 'trustFolder', detail: `${target.text} — ${ctx.cwd}`, keys: [...moves, KEY_ENTER] };
  },
  spawnEnv: (_paneId, account): Record<string, string> =>
    account ? { CODEX_HOME: path.join(koraHome(), 'accounts', 'codex', account) } : {},
  skipPermissionArgs: () => ['--dangerously-bypass-approvals-and-sandbox'],
  // Edits inside the workspace-write sandbox need no approval; anything that must leave it asks (codex 0.155:
  // `-s workspace-write -a on-request`). There is no `--full-auto` flag — launched with it, codex exits 2 at once.
  acceptEditsArgs: () => ['-s', 'workspace-write', '-a', 'on-request'],
  modelArgs: (model, effort) => [...(model ? ['--model', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : [])],
};

// ── antigravity (agy) ───────────────────────────────────────────────────────────────────────────────────────
// Was falling through to the null default adapter — so agy never got auto-answer, edit-accept, or skip-perms.
// Detection is manifest-driven (manifests/antigravity.toml, aliased to 'antigravity'); this decides. Its edit
// approval is "Accept this file edit?" with "1. Yes, accept this change"; under allowlist we accept it (never a
// command). Account-dir isolation flag is unverified for agy, so spawnEnv is {} until captured (documented gap).
const antigravityAdapter: AgentAdapter = {
  id: 'antigravity',
  canCompact: false,
  autoAnswer: (ctx) => {
    if (ctx.allowEdits && isEditApproval(ctx.screen)) return acceptEditPlan(ctx.screen, 'accept file edit');
    return null;
  },
  spawnEnv: () => ({}),
  skipPermissionArgs: () => ['--dangerously-skip-permissions'],
  acceptEditsArgs: () => ['--mode', 'accept-edits'],                 // agy --help: --mode (accept-edits, plan)
  modelArgs: (model, effort) => [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])],
};

// ── gemini ──────────────────────────────────────────────────────────────────────────────────────────────────
// Detection stays on the generic manifest; what was missing was the launch posture: with no adapter a
// full-access worker still prompted for every edit (and a cross-agent fleet's first gemini worker sat
// blocked). Flags from `gemini --help`: --yolo / --approval-mode {default,auto_edit,yolo,plan}, -m model.
const geminiAdapter: AgentAdapter = {
  id: 'gemini',
  canCompact: false,
  autoAnswer: () => null,
  spawnEnv: () => ({}),
  skipPermissionArgs: () => ['--yolo'],
  acceptEditsArgs: () => ['--approval-mode', 'auto_edit'],
  modelArgs: (model) => (model ? ['-m', model] : []),
};

// ── opencode (swarm workers) ────────────────────────────────────────────────────────────────────────────────
// Read from the opencode source at v1.18.32 (docs/swarm/S3-LIVE-CHECKLIST.md lists what still needs a live check):
//   • packages/opencode/src/cli/cmd/tui.ts:108 — `--auto` "auto-approve permissions that are not explicitly denied"
//     (`--yolo` / `--dangerously-skip-permissions` are hidden aliases). `-m provider/model`; no effort flag on the
//     TUI (`--variant` is `run`-only), so effort is dropped.
//   • packages/tui/src/routes/session/permission.tsx:385-432 — the dialog: "△ Permission required", then the icon +
//     title ("→ Edit <path>", "# Shell command", "→ Read <path>", "✱ Glob …", "← Access external directory …"),
//     options `Allow once | Allow always | Reject` in a row; :539 the initial selection is the FIRST key ("Allow
//     once"), so Enter = allow once. Left/right move it; Esc = reject.
// autoAnswer (allowlist posture only): an in-worktree file EDIT or a read-only lookup (Read/Glob/Grep/List) gets
// "Allow once". Never a shell command, an external directory, a web fetch, a subagent task, or the doom-loop
// prompt — those are the agent asking to act outside its lane and stay a human's (or the leader's) call. Swarm
// workers normally never see the dialog: swarmPermissionEnv allows edits up front via OPENCODE_PERMISSION.
const OPENCODE_PERMISSION_DIALOG = /△\s*Permission required/;
// The dialog's title line (the first non-empty line under "Permission required"): only these are auto-answered.
const OPENCODE_SAFE_TITLE = /^(?:→\s*(?:Edit|Read|List)\s+\S|✱\s*(?:Glob|Grep)\s+")/;
/** The permission dialog's title line ("→ Edit src/x.ts", "# Shell command", …), or null when there is no dialog. */
function opencodePermissionTitle(screen: string): string | null {
  const lines = screen.split('\n').map((l) => l.replace(/[│┃╹]/g, ' ').trim());
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (OPENCODE_PERMISSION_DIALOG.test(lines[i])) { at = i; break; }
  if (at < 0) return null;
  for (let i = at + 1; i < lines.length; i++) if (lines[i]) return lines[i];
  return null;
}
export const opencodeAdapter: AgentAdapter = {
  id: 'opencode',
  canCompact: false,
  autoAnswer: (ctx) => {
    if (!ctx.allowEdits || !/Allow once/.test(ctx.screen)) return null;
    const title = opencodePermissionTitle(ctx.screen);
    if (!title || !OPENCODE_SAFE_TITLE.test(title)) return null;
    return { kind: 'editApproval', detail: `allow once: ${title}`, keys: [KEY_ENTER] };
  },
  spawnEnv: () => ({}),                    // the swarm env comes from swarmPaneEnv (SwarmService), not per account
  skipPermissionArgs: () => ['--auto'],
  acceptEditsArgs: () => [],               // posture rides OPENCODE_PERMISSION (swarmPermissionEnv), not argv
  modelArgs: (model) => (model ? ['-m', model] : []),
};

// ── koragent (swarm workers, swarm.workerBackend = 'koragent') ─────────────────────────────────────────────────
// Everything a Koragent worker needs rides in its TaskSpec (`--task-spec`): the ordered model route, the permission
// posture, the budget. Its state comes from its event stream, never the screen, so it has no dialog to auto-answer
// and no argv knobs here. A human typing in the pane still reaches its TUI through the PTY.
export const koragentAdapter: AgentAdapter = {
  id: 'koragent',
  canCompact: false,
  autoAnswer: () => null,
  spawnEnv: () => ({}),
  skipPermissionArgs: () => [],            // TaskSpec.permission
  acceptEditsArgs: () => [],               // TaskSpec.permission
  modelArgs: () => [],                     // TaskSpec.route
};

// ── default (gemini, cursor, copilot, shell, unknown, …) ────────────────────────────────────────────────────
// No compaction, never auto-answer, no per-account isolation until an adapter is written for that agent.
function makeDefaultAdapter(id: AgentId): AgentAdapter {
  return { id, canCompact: false, autoAnswer: () => null, spawnEnv: () => ({}), skipPermissionArgs: () => [], acceptEditsArgs: () => [], modelArgs: () => [] };
}

export function adapterFor(agent: AgentId): AgentAdapter {
  if (agent === 'claude') return claudeAdapter;
  if (agent === 'codex') return codexAdapter;
  if (agent === 'antigravity') return antigravityAdapter;
  if (agent === 'gemini') return geminiAdapter;
  if (agent === 'opencode') return opencodeAdapter;
  if (agent === 'koragent') return koragentAdapter;
  return makeDefaultAdapter(agent);
}
