// swarm-step.ts — a swarm worker's latest step, in a few words, for the fleet panel's thought bubble
// (`FleetSwarmWorker.step` / runtime `SwarmWorkerMeta.step`). Pure mapping only; the DB read lives in
// `OpencodeActivity.readSteps` (swarm-watchdog.ts, same db handle as the watchdog's activity read) and the
// Koragent side is fed inline from `tool.start` events (swarm.ts `onKoragentEvent`). Never throws; a step this
// module cannot make sense of falls back to `{ kind: 'other', text: 'using <tool>' }` rather than null, so a
// null step means "no signal at all", not "an unrecognised tool".
import path from 'node:path';
import type { SwarmStep, SwarmStepKind } from '../protocol/types';

/** OpenCode / Koragent tool name → step kind. Unlisted tools (glob, grep, task, todowrite, kora_*, skill, …) are 'other'. */
const KIND_BY_TOOL: Record<string, SwarmStepKind> = {
  webfetch: 'fetch',
  websearch: 'search',
  read: 'read',
  write: 'write',
  edit: 'write',
  bash: 'run',
};

const MAX_LEN = 48;

/** Collapse whitespace and trim; never throws on a non-string. */
function clean(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Truncates to `n` chars, an ellipsis taking the last slot when cut. */
export function truncateStepText(s: string, n = MAX_LEN): string {
  const t = clean(s);
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function basenameOf(p: string): string | null {
  const t = clean(p);
  if (!t) return null;
  try {
    return path.basename(t) || null;
  } catch {
    return null;
  }
}

/** A worker's own report file (`.../report.md`), reported as "writing report" instead of the basename. */
export function isReportPath(p: string): boolean {
  return /(^|[/\\])report\.md$/i.test(clean(p));
}

function stripQuotes(s: string): string {
  return clean(s).replace(/^["']|["']$/g, '');
}

/** The step kind for a tool name (opencode or koragent); 'other' when the tool is not one of the mapped ones. */
export function swarmStepKind(tool: string): SwarmStepKind {
  return KIND_BY_TOOL[clean(tool).toLowerCase()] ?? 'other';
}

/**
 * The step text for a tool call, given its kind and a "target" — the thing being read/searched/written/run, as
 * loosely as each caller can supply it (a URL, a query, a file path, a shell command, or a free-form title).
 */
function textFor(kind: SwarmStepKind, tool: string, target: string): string {
  switch (kind) {
    case 'fetch':
      return `reading ${hostnameOf(target) || truncateStepText(target, 30) || 'a page'}`;
    case 'search':
      return `searching "${truncateStepText(stripQuotes(target), 40)}"`;
    case 'read':
      // OpenCode spills long tool output to its own tool-output folder and reads it back: that's reviewing, not a file.
      if (/[/\\]tool-output[/\\]/.test(target)) return 'reviewing results';
      return `reading ${basenameOf(target) || truncateStepText(target, 30) || 'a file'}`;
    case 'write':
      return isReportPath(target) ? 'writing report' : `writing ${basenameOf(target) || truncateStepText(target, 30) || 'a file'}`;
    case 'run': {
      // A shell fetch is still reading a page: show where, not the curl flags.
      const url = /^\s*(?:curl|wget|http)\b[^\n]*?(https?:\/\/[^\s"')]+)/i.exec(target)?.[1];
      if (url) return `fetching ${hostnameOf(url) || 'a page'}`;
      return `running ${truncateStepText(target, 30) || 'a command'}`;
    }
    default:
      if (clean(tool).toLowerCase() === 'task') return 'splitting off a subtask';
      return `using ${clean(tool) || 'a tool'}`;
  }
}

/**
 * One OpenCode `part` row (its `data` JSON, already parsed) → a step, or null when the part is not one the fleet
 * panel should show (a step-start/step-finish/patch/compaction marker, or a tool the row doesn't name).
 * `at` is the part's own timestamp (the caller's `part.time_created`).
 */
export function partToStep(part: unknown, at: number): SwarmStep | null {
  if (!part || typeof part !== 'object') return null;
  const p = part as { type?: unknown; tool?: unknown; state?: { input?: Record<string, unknown> } };
  if (p.type === 'text' || p.type === 'reasoning') return { text: 'thinking…', at, kind: 'think' };
  if (p.type !== 'tool') return null;
  const tool = clean(p.tool);
  if (!tool) return null;
  const kind = swarmStepKind(tool);
  const input = p.state?.input ?? {};
  const target =
    kind === 'fetch' ? clean(input.url)
    : kind === 'search' ? clean(input.query)
    : kind === 'read' || kind === 'write' ? clean(input.filePath ?? input.path)
    : kind === 'run' ? clean(input.command)
    : '';
  return { text: truncateStepText(textFor(kind, tool, target)), at, kind };
}

/** A Koragent `tool.start` event (`{ tool, title }`) → a step. Always returns one (Koragent always names a tool). */
export function stepFromKoragentToolStart(e: { tool?: unknown; title?: unknown }, at: number): SwarmStep {
  const tool = clean(e.tool);
  const kind = swarmStepKind(tool);
  const target = clean(e.title) || tool;
  return { text: truncateStepText(textFor(kind, tool, target)), at, kind };
}
