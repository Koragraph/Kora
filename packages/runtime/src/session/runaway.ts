// Runaway guard (overnight B8). A turn that reads the same file range three times or re-runs the same failing command three
// times is stuck in a loop that burns tokens (every repeat is another full-context call). The guard watches the tool_use /
// tool_result stream of ONE turn and says so once per loop; the thread shows a quiet "looks stuck" line and the user's
// Stop button ends the turn. It never stops anything by itself. Pure; the driver feeds it.
export interface StuckVerdict { kind: 'reread' | 'refail'; key: string; count: number; message: string }

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
/** The END of a path is what a person recognises (the file), not the checkout prefix. */
const tailOf = (s: string, n: number): string => (s.length > n ? `...${s.slice(s.length - (n - 3))}` : s);
const norm = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();

export class RunawayGuard {
  private uses = new Map<string, { name: string; input: any }>();
  private reads = new Map<string, number>();
  private fails = new Map<string, number>();
  private told = new Set<string>();
  constructor(private limit = 3) {}

  /** A new user turn: counts start over. */
  beginTurn(): void { this.uses.clear(); this.reads.clear(); this.fails.clear(); this.told.clear(); }

  /** The agent asked to run a tool. */
  onToolUse(id: string, name: string, input: any): StuckVerdict | null {
    if (!id || this.uses.has(id)) return null; // the SDK repeats an assistant message once per content block
    this.uses.set(id, { name, input });
    if (this.uses.size > 400) this.uses.delete(this.uses.keys().next().value as string);
    // Read, edit, read again to check is ordinary work: a change to a file starts its read count over.
    if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
      const fp = input?.file_path ?? input?.notebook_path;
      if (typeof fp === 'string') { const pre = `read:${fp}:`; for (const k of [...this.reads.keys()]) if (k.startsWith(pre)) { this.reads.delete(k); this.told.delete(k); } }
      return null;
    }
    if (name === 'Read') {
      const path = input?.file_path ?? input?.path;
      if (typeof path !== 'string') return null;
      // The same path with the same window: a different range of one file is ordinary reading.
      const key = `read:${path}:${input?.offset ?? ''}:${input?.limit ?? ''}`;
      const n = (this.reads.get(key) ?? 0) + 1; this.reads.set(key, n);
      if (n >= this.limit && !this.told.has(key)) {
        this.told.add(key);
        return { kind: 'reread', key, count: n, message: `Looks stuck: this turn has read ${tailOf(path, 60)} ${n} times${input?.offset ? ' (the same lines)' : ''}. Press Stop if it is going in circles.` };
      }
    }
    return null;
  }

  /** A tool result came back. Only failures count for the "same failing call" rule. */
  onToolResult(id: string, isError: boolean): StuckVerdict | null {
    const use = this.uses.get(id);
    if (!use || !isError) return null;
    const { name, input } = use;
    let key: string | null = null; let what = '';
    if (name === 'Bash') { const c = norm(input?.command); if (c) { key = `bash:${c}`; what = `\`${clip(c, 80)}\``; } }
    else if (name === 'Edit' || name === 'MultiEdit' || name === 'Write') { const f = input?.file_path; if (typeof f === 'string') { key = `${name}:${f}`; what = `${name} on ${clip(f, 80)}`; } }
    else if (name.startsWith('mcp__') || name === 'Grep' || name === 'Glob' || name === 'WebFetch') { key = `${name}:${norm(JSON.stringify(input ?? {}))}`; what = name.replace(/^mcp__/, '').replace(/__/g, ' '); }
    if (!key) return null;
    const n = (this.fails.get(key) ?? 0) + 1; this.fails.set(key, n);
    if (n >= this.limit && !this.told.has(key)) {
      this.told.add(key);
      return { kind: 'refail', key, count: n, message: `Looks stuck: ${what} has failed ${n} times in this turn. Press Stop if it keeps retrying the same thing.` };
    }
    return null;
  }
}
