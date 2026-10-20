// The opencode side of a swarm worker: its pane env (OPENCODE_CONFIG_DIR / _CONTENT / _PERMISSION /
// _DISABLE_AUTOUPDATE, the provider's key, KORA_REPORT…) and the state plugin.
//
// Every opencode fact used here was read from the opencode source at v1.18.32 (docs/swarm/S3-LIVE-CHECKLIST.md lists
// what still needs a live confirmation):
//   - packages/core/src/flag/flag.ts: OPENCODE_CONFIG_DIR, OPENCODE_CONFIG_CONTENT, OPENCODE_PERMISSION,
//     OPENCODE_DISABLE_AUTOUPDATE (truthy "1"/"true").
//   - packages/opencode/src/config/config.ts:432-490: OPENCODE_CONFIG_DIR is a config directory (its opencode.json and
//     `{plugin,plugins}/*.{ts,js}` load); OPENCODE_CONFIG_CONTENT merges AFTER the project's opencode.json;
//     :559 OPENCODE_PERMISSION is JSON, deep-merged over the resolved `permission`.
//   - packages/core/src/v1/config/config.ts:57 `share: "manual" | "auto" | "disabled"`; :64 `autoupdate`.
//   - packages/core/src/v1/config/permission.ts: `question` is a permission action ("deny" keeps the question
//     dialog away from an unattended worker); `external_directory` takes a pattern map.
//   - packages/core/src/plugin/provider/opencode.ts:176: the Zen key env var is OPENCODE_API_KEY (no key → only
//     cost-0 models, apiKey "public").
//   - packages/opencode/src/plugin/index.ts:98-110: every export of a plugin module must be a plugin function.
import fs from 'node:fs';
import path from 'node:path';
import type { SwarmLocalProviderId, SwarmProviderId, SwarmWorkerMeta } from '../protocol/types';
import { koraHome } from '../protocol/types';
import type { RuntimeMode } from '../session/events';
import { swarmBoundedReadsMode, swarmTokenCeiling } from '../util/savings-settings';
import { OPENCODE_PATTERN_KILL_DENY } from '../session/sensitive-guard';

/** ~/.kora/opencode — the OPENCODE_CONFIG_DIR every swarm worker gets (holds plugins/kora-state.js). */
function opencodeConfigDir(): string { return path.join(koraHome(), 'opencode'); }

/** The env var opencode reads for each provider's key (models.dev `env`; Zen from oc provider/opencode.ts:176). */
const KEY_ENV: Record<SwarmProviderId, string> = {
  zen: 'OPENCODE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
};

const LOCAL_NAME: Record<SwarmLocalProviderId, string> = { ollama: 'Ollama (local)', lmstudio: 'LM Studio (local)' };
const isLocal = (p: string): p is SwarmLocalProviderId => p === 'ollama' || p === 'lmstudio';

/**
 * The opencode provider block for a local server: OpenAI-compatible (`@ai-sdk/openai-compatible`, opencode's
 * documented Ollama / LM Studio setup) at `<baseUrl>/v1`, declaring just the worker's model. No key.
 */
export function localProviderConfig(provider: SwarmLocalProviderId, baseUrl: string, model: string): Record<string, unknown> {
  const name = model.slice(model.indexOf('/') + 1);
  return { [provider]: { npm: '@ai-sdk/openai-compatible', name: LOCAL_NAME[provider], options: { baseURL: `${baseUrl.replace(/\/+$/, '')}/v1` }, models: { [name]: { name, tool_call: true } } } };
}

function localBaseUrl(provider: SwarmLocalProviderId): string {
  try { return require('../config').loadConfig().swarm.local[provider].baseUrl; } catch { return provider === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234'; }
}

/**
 * Env for the plugin's token levers: KORA_SWARM_BOUND_READ (off|shadow|on), the declaration lines the graph packet named
 * (so a bounded read lands on the right code), a per-worker token ceiling, and where shadow decisions are logged.
 */
function savingsEnv(hints?: Record<string, number[]>): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    out.KORA_SWARM_BOUND_READ = swarmBoundedReadsMode();
    const c = swarmTokenCeiling();
    if (c > 0) out.KORA_SWARM_TOKEN_CEILING = String(c);
    out.KORA_SWARM_BOUND_LOG = path.join(koraHome(), 'swarm', 'bounded-reads.jsonl');
    if (hints && Object.keys(hints).length) {
      const j = JSON.stringify(hints);
      if (j.length <= 4000) out.KORA_SWARM_READ_HINTS = j;
    }
  } catch { /* the levers are optional: a worker without them still runs */ }
  return out;
}

/** `■ KIND name @ path:line` / ranked-tail lines of a graph context packet -> { path: [lines] }. */
export function packetReadHints(packetText: string): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const l of (packetText || '').split('\n')) {
    const m = /@\s+(\S+?):(\d+)\b/.exec(l);
    if (!m) continue;
    const n = parseInt(m[2]!, 10);
    if (!Number.isFinite(n) || n < 1) continue;
    const f = m[1]!.replace(/^\.\//, '');
    (out[f] ??= []).includes(n) || out[f]!.push(n);
  }
  return out;
}

/** Everything a swarm worker's pane needs in its env (PANE_ENV swarm keys + OPENCODE_* + the provider key only). */
export function swarmPaneEnv(meta: SwarmWorkerMeta, opts: { apiKey: string | null; runtimeMode?: RuntimeMode; readHints?: Record<string, number[]>; /** the worker's folder: its extension servers (Settings › Extensions, "also for workers") */ cwd?: string }): Record<string, string> {
  const local = isLocal(meta.provider) ? meta.provider : null;
  const keyVar = local ? null : KEY_ENV[meta.provider as SwarmProviderId];
  // small_model drives titles and summaries; pinned to the worker's own (free) model so opencode never reaches for a paid
  // "small" model on its own (an account with a Zen key would otherwise get one).
  const content: Record<string, unknown> = { autoupdate: false, share: 'disabled', small_model: meta.model };
  // The key rides in the env var only; the config references it, never embeds it (OPENCODE_CONFIG_CONTENT is
  // visible in `ps e` output and logs just like the var, but a config dump never carries the literal key).
  if (local) content.provider = localProviderConfig(local, localBaseUrl(local), meta.model);
  else if (opts.apiKey && meta.provider !== 'zen') content.provider = { [meta.provider]: { options: { apiKey: `{env:${keyVar}}` } } };
  // Servers the user enabled for OpenCode workers. Never on a local model: its promise is that nothing leaves the machine.
  if (opts.cwd && !local) {
    try {
      const ext = require('../extensions') as typeof import('../extensions');
      const servers = ext.sessionServers('opencode', { cwd: opts.cwd, isWorker: true }, (require('../trust/store') as typeof import('../trust/store')).isFolderTrusted(opts.cwd));
      if (servers.length) content.mcp = (require('../extensions/wire') as typeof import('../extensions/wire')).opencodeEntries(servers);
    } catch { /* a worker without extensions still runs */ }
  }
  const env: Record<string, string> = {
    KORA_REPORT: meta.reportPath,
    KORA_SWARM_TASK_ID: meta.taskId,
    KORA_SWARM_MODEL: meta.model,
    KORA_SWARM_PROVIDER: meta.provider,
    KORA_NODE: process.execPath,
    OPENCODE_CONFIG_DIR: opencodeConfigDir(),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(content),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    ...savingsEnv(opts.readHints),
    // Web research is worker legwork (the Swarm leader has no WebSearch/WebFetch): OpenCode's websearch tool is only on
    // for its own provider unless this is set. Never on a local model, whose promise is that nothing leaves the machine.
    ...(local ? {} : { OPENCODE_ENABLE_EXA: '1' }),
    ...swarmPermissionEnv(opts.runtimeMode, { reportPath: meta.reportPath }),
  };
  // Only this worker's provider key. A Zen key makes opencode load the PAID Zen models too — the picker only ever
  // passes a cost-0 id with -m (S2), so a present key never bills, but it is still passed only when the user set one.
  if (opts.apiKey && keyVar) env[keyVar] = opts.apiKey;
  return env;
}

/**
 * OPENCODE_PERMISSION from the thread's permission posture (the report path always writable).
 *   full-access / auto                  → everything allowed (the pane is also launched with `--auto`)
 *   approval-required / auto-accept-edits → edits allowed, shell asks (a blocked worker notifies the leader)
 * Always: `question: deny` (nobody answers an unattended worker's question dialog; the preamble tells it to put
 * blockers in the report instead) and the report's directory allowed as an external directory (it is inside the
 * worktree normally; this covers the ~/.kora/swarm/reports fallback).
 */
/** Shell commands that only read: allowed without a prompt in the postures that otherwise ask about shell. */
const READ_ONLY_SHELL: Record<string, 'allow'> = Object.fromEntries(
  ['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'which', 'git status', 'git diff', 'git log', 'git show', 'git branch', 'node --version', 'node -v', 'npm --version', 'npm -v']
    .flatMap((c) => [[c, 'allow'], [`${c} *`, 'allow']]),
) as Record<string, 'allow'>;

export function swarmPermissionEnv(runtimeMode: RuntimeMode | undefined, opts: { reportPath: string }): Record<string, string> {
  const reportDir = path.dirname(opts.reportPath);
  const full = runtimeMode === 'full-access' || runtimeMode === 'auto';
  // Key order is precedence in opencode (later keys win), so the catch-all comes first.
  // An unattended worker must never act on the user's desktop: `open <url>` pops a browser window on their Mac
  // (seen live), osascript drives other apps. Denied in every posture; later keys win in opencode.
  const desktopDeny = { 'open *': 'deny', 'open': 'deny', 'osascript *': 'deny', 'xdg-open *': 'deny', ...Object.fromEntries(OPENCODE_PATTERN_KILL_DENY.map((p) => [p, 'deny'])) };
  const permission: Record<string, unknown> = full
    // external_directory denied even under full access: a worker edits only its own worktree (the report lives in it).
    ? { '*': 'allow', bash: { '*': 'allow', ...desktopDeny }, question: 'deny', external_directory: 'deny' }
    // Read-only lookups never ask (QA 2026-10-10: `ls; node --version; cat opencode.json` blocked a worker on a prompt nobody
    // answers). Anything that writes or runs code still asks, and a blocked worker waits for the HUMAN (see the lead's
    // BLOCKED note). Outside the worktree is denied outright instead of asking.
    : { edit: 'allow', bash: { '*': 'ask', ...READ_ONLY_SHELL, ...desktopDeny }, question: 'deny', external_directory: { '*': 'deny', [`${reportDir}/**`]: 'allow' } };
  return { OPENCODE_PERMISSION: JSON.stringify(permission) };
}

/**
 * The plugin opencode loads from OPENCODE_CONFIG_DIR/plugins. It forwards the root session's status to Kora through
 * `kora hook opencode-event` (→ pane.reportState + swarm.reportEvent). Plain JS, no imports beyond node builtins
 * (opencode runs plugins under Bun, which has node:child_process). ONE export, a function: opencode rejects a
 * plugin module with any non-function export. It does nothing outside a Kora pane (no KORA_PANE_ID).
 */
const OPENCODE_PLUGIN_SOURCE = `// Written by Kora (swarm mode). Regenerated on every install; edits are overwritten.
// Forwards opencode session state to the Kora daemon: kora hook opencode-event.
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

// ---- token savings (docs/overnight-2026-10-14/S4-lanes-swarm-graph.md) -------------------------------------------
// Bounded read: a whole-file read of a long source file is re-billed on every later call. KORA_SWARM_BOUND_READ is
// "on" | "shadow" | "off" (Settings > Context). Same rules as graph/read-window.ts: code files over 300 lines, a window
// of 100-250 lines, the second read of a path passes whole, fail open.
const CODE_RE = /\\.(js|mjs|cjs|ts|tsx|jsx|py|go|rb|java|rs|c|cc|cpp|h|hpp|cs|php|kt|swift|scala|ex|exs|sh|sql)$/i
const MIN_LINES = 300
const WIN_MIN = 100
const WIN_MAX = 250
const NO_GAIN = 0.75
const DECL_RE = /^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|type|enum|const|struct|impl|trait|fn|def|func|pub\\s+fn)\\s+([A-Za-z_$][\\w$]*)|^[ \\t]+(?:async\\s+)?(?:def|fn|func|function)\\s+([A-Za-z_$][\\w$]*)/
const EXPLORE_TOOLS = ["read", "grep", "glob", "list", "webfetch", "websearch", "codesearch", "task"]
const WRITE_TOOLS = ["edit", "write", "patch", "apply_patch", "multiedit"]
function readHints() {
  try { const j = JSON.parse(process.env.KORA_SWARM_READ_HINTS || "{}"); return j && typeof j === "object" ? j : {} } catch { return {} }
}
function logBound(f, rec) {
  try { if (f) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(rec) + "\\n") } } catch {}
}
function chooseWindow(total, hintLines, outline) {
  let lo = 1
  let hi = Math.min(total, WIN_MAX)
  const first = Array.isArray(hintLines) ? hintLines.find((n) => Number.isInteger(n) && n >= 1 && n <= total) : undefined
  if (first) {
    lo = Math.max(1, first - 12)
    let end = total
    for (const o of outline) { if (o.line > first) { end = o.line - 1; break } }
    hi = Math.min(total, Math.max(end, lo + WIN_MIN - 1))
    if (hi - lo + 1 > WIN_MAX) hi = lo + WIN_MAX - 1
  }
  if (hi - lo + 1 < WIN_MIN) { hi = Math.min(total, lo + WIN_MIN - 1); lo = Math.max(1, hi - WIN_MIN + 1) }
  if (hi - lo + 1 >= total * NO_GAIN) return null
  return { offset: lo, limit: hi - lo + 1 }
}
function planRead(args, directory, seen, hints) {
  const fp = args && (args.filePath || args.file_path || args.path)
  if (typeof fp !== "string" || !fp) return null
  if (args.offset != null || args.limit != null) return null
  if (!CODE_RE.test(fp)) return null
  const abs = path.resolve(directory, fp)
  const rel = path.relative(directory, abs).split(path.sep).join("/")
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null
  if (seen.has(abs)) return null
  seen.add(abs)
  const st = fs.statSync(abs)
  if (!st.isFile() || st.size > 4 * 1024 * 1024) return null
  const text = fs.readFileSync(abs, "utf8")
  const lines = text.split("\\n")
  const total = text.endsWith("\\n") ? lines.length - 1 : lines.length
  if (total <= MIN_LINES) return null
  const outline = []
  for (let i = 0; i < lines.length && outline.length < 400; i++) {
    const m = DECL_RE.exec(lines[i])
    if (m) outline.push({ name: m[1] || m[2], line: i + 1 })
  }
  const h = hints[rel] || hints[Object.keys(hints).find((k) => rel.endsWith(k) || k.endsWith(rel)) || ""]
  const w = chooseWindow(total, h, outline)
  if (!w) return null
  const end = w.offset + w.limit - 1
  let note = "kora: this read was bounded to lines " + w.offset + "-" + end + " of " + total + " in " + rel + " (a whole-file read is re-billed on every later call). Read it again for the whole file, or with offset/limit for another range."
  if (outline.length) {
    const step = Math.max(1, Math.ceil(outline.length / 40))
    const items = []
    for (let i = 0; i < outline.length; i += step) items.push(outline[i].name + ":" + outline[i].line)
    note += " Outline (name:line): " + items.join(", ")
  }
  return { w, rel, total, note }
}

export const KoraState = async (ctx) => {
  const node = process.env.KORA_NODE
  const bin = process.env.KORA_BIN
  const pane = process.env.KORA_PANE_ID
  if (!node || !bin || !pane) return {}
  const directory = (ctx && (ctx.directory || ctx.worktree)) || process.cwd()
  const boundMode = String(process.env.KORA_SWARM_BOUND_READ || "off").toLowerCase()
  const ceiling = Number(process.env.KORA_SWARM_TOKEN_CEILING) || 0
  const hints = readHints()
  const boundLog = process.env.KORA_SWARM_BOUND_LOG || ""
  const seen = new Set()
  const notes = new Map()
  const spent = new Map()
  let overCeiling = false
  // Past the ceiling the explore tools stop at once; past ceiling + grace (20%: room to finish the edit in hand) bash, edits
  // and writes stop too, except the report file, so a runaway worker can still say what it did and finish.
  const graceEnv = process.env.KORA_SWARM_TOKEN_GRACE
  const grace = graceEnv && Number(graceEnv) >= 0 ? Number(graceEnv) : Math.floor(ceiling * 0.2)
  const reportFile = process.env.KORA_REPORT ? path.resolve(directory, process.env.KORA_REPORT) : ""
  let hardOver = false
  let root = null
  let last = ""
  // The worker box's feed (docs/fleet/WORKER-BOXES.md): finished tool calls and text parts, batched — one hook
  // process per ~1.5 s at most, and the rest rides on the idle event so the last answer lands before "done".
  const calls = new Map()
  let feed = []
  let feedTimer = null
  const feedPush = (item) => {
    feed.push(item)
    if (feed.length > 40) feed = feed.slice(-40)
    if (!feedTimer) feedTimer = setTimeout(() => { feedTimer = null; if (feed.length) { const items = feed; feed = []; send({ type: "feed", items }) } }, 1500)
  }
  const feedTake = () => { if (feedTimer) { clearTimeout(feedTimer); feedTimer = null } const items = feed; feed = []; return items }
  const send = (payload) => {
    try {
      const child = spawn(node, [bin, "hook", "opencode-event", "--stdin-json", JSON.stringify(payload)], { stdio: "ignore", env: process.env })
      child.on("error", () => {})
      child.unref()
    } catch {}
  }
  return {
    "tool.execute.before": async (input, output) => {
      try {
        if (input && input.callID) { calls.set(input.callID, { tool: input.tool, args: (output && output.args) || {} }); if (calls.size > 200) calls.delete(calls.keys().next().value) }
      } catch {}
      try {
        const tool = input && input.tool
        if (overCeiling && EXPLORE_TOOLS.includes(tool)) {
          throw new Error("kora: this task used its token budget (" + ceiling + "). Stop exploring: finish the edit you are on, verify it, write your report, and stop.")
        }
        if (hardOver && (tool === "bash" || WRITE_TOOLS.includes(tool))) {
          const a = (output && output.args) || {}
          const fp = a.filePath || a.file_path || a.path
          const toReport = reportFile && tool !== "bash" && typeof fp === "string" && fp && path.resolve(directory, fp) === reportFile
          if (!toReport) throw new Error("kora: this task is well past its token budget (" + ceiling + " + " + grace + "). STOP: no more commands or edits. " + (reportFile ? "Write your report to " + reportFile + " (what you changed, what is left open) and finish." : "Write your report and finish."))
        }
        if (WRITE_TOOLS.includes(tool)) {
          const a = (output && output.args) || {}
          const fp = a.filePath || a.file_path || a.path
          if (typeof fp === "string" && fp) seen.add(path.resolve(directory, fp))
          return
        }
        if (tool !== "read" || boundMode === "off") return
        const plan = planRead(output.args, directory, seen, hints)
        if (!plan) return
        logBound(boundLog, { ts: Date.now(), task: process.env.KORA_SWARM_TASK_ID, mode: boundMode, file: plan.rel, offset: plan.w.offset, limit: plan.w.limit, total: plan.total })
        if (boundMode !== "on") return
        output.args.offset = plan.w.offset
        output.args.limit = plan.w.limit
        notes.set(input.callID, plan.note)
        if (notes.size > 100) notes.delete(notes.keys().next().value)
      } catch (e) {
        if (e && typeof e.message === "string" && e.message.startsWith("kora:")) throw e
      }
    },
    "tool.execute.after": async (input, output) => {
      try {
        if (!input || (root !== null && input.sessionID && input.sessionID !== root)) throw 0
        const c = calls.get(input.callID) || { tool: input.tool, args: {} }
        calls.delete(input.callID)
        const a = c.args || {}
        const subject = a.command || a.filePath || a.file_path || a.path || a.pattern || a.query || a.url || a.description || (output && output.title) || ""
        const md = (output && output.metadata) || {}
        const fd = md.filediff || {}
        const failed = !!(md.error || (typeof (output && output.output) === "string" && /^error\\b/i.test(output.output)))
        feedPush({ k: "tool", id: String(input.callID || Date.now()), tool: String(c.tool || input.tool || "tool"), title: String(subject).split("\\n")[0].slice(0, 200), failed, added: typeof fd.additions === "number" ? fd.additions : null, removed: typeof fd.deletions === "number" ? fd.deletions : null, detail: failed && typeof output.output === "string" ? output.output.slice(-1000) : null })
      } catch {}
      try {
        const note = notes.get(input && input.callID)
        if (!note) return
        notes.delete(input.callID)
        if (output && typeof output.output === "string") output.output = output.output + "\\n\\n" + note
      } catch {}
    },
    event: async ({ event }) => {
      const type = event && event.type
      const p = (event && event.properties) || {}
      if (type === "message.updated") {
        // AssistantMessage.tokens {input, output, reasoning, cache:{read,write}} (@opencode-ai/sdk 1.18.32 types.gen.d.ts).
        // Cache READS are the cheap repeated part and are not counted; what is counted is what the provider processed fresh.
        try {
          const info = p.info || {}
          if (ceiling > 0 && info.role === "assistant" && info.id && info.tokens && (root === null || info.sessionID === root)) {
            const t = info.tokens
            spent.set(info.id, (Number(t.input) || 0) + (Number(t.output) || 0) + (Number(t.reasoning) || 0) + (Number(t.cache && t.cache.write) || 0))
            let sum = 0
            for (const v of spent.values()) sum += v
            if (sum > ceiling) overCeiling = true
            if (sum > ceiling + grace) hardOver = true
          }
        } catch {}
        return
      }
      if (type === "message.part.updated") {
        try {
          const part = p.part || {}
          if (part.type === "text" && part.time && part.time.end && typeof part.text === "string" && part.text.trim() && (root === null || part.sessionID === root) && !part.synthetic) feedPush({ k: "text", id: String(part.id), text: part.text.slice(-16000) })
        } catch {}
        return
      }
      if (type !== "session.status" && type !== "session.idle" && type !== "session.error") return
      // Only the worker's own (first) session: a subagent's idle must not read as the worker going idle.
      if (p.sessionID) {
        if (root === null && type === "session.status") root = p.sessionID
        if (root !== null && p.sessionID !== root) return
      }
      if (type === "session.status") {
        const s = p.status || {}
        const key = String(s.type) + ":" + String(s.attempt || 0)
        if (key === last) return
        last = key
        send({ type, status: s.type, attempt: s.attempt, message: typeof s.message === "string" ? s.message.slice(0, 500) : undefined, next: s.next })
      } else if (type === "session.idle") {
        last = "idle:0"
        const items = feedTake()
        send(items.length ? { type, feed: items } : { type })
      } else {
        const e = p.error || {}
        const msg = (e.data && e.data.message) || e.message || e.name || "error"
        send({ type, message: String(msg).slice(0, 500) })
      }
    },
  }
}
`;

/** Writes ~/.kora/opencode/plugins/kora-state.js; returns its path. Idempotent (rewrites only on change). */
export function writeOpencodePlugin(): string {
  const file = path.join(opencodeConfigDir(), 'plugins', 'kora-state.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current: string | null = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* first install */ }
  // atomic: a worker starting at this moment must read the old plugin or the new one, never half of it (Kora Dev and a second daemon
  // share nothing here, but a worker launch and a daemon start can coincide)
  if (current !== OPENCODE_PLUGIN_SOURCE) (require('../util/atomic-write') as typeof import('../util/atomic-write')).writeFileAtomic(file, OPENCODE_PLUGIN_SOURCE);
  return file;
}
