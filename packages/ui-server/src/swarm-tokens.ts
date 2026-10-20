// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- plain Node: a read-only look into OpenCode's own session DB.
// Measured worker tokens for the swarm value meter. OpenCode keeps per-session token totals in its own DB
// (`session.tokens_*`, the source `kora swarm usage` joins). A swarm task runs in its own worktree, so the root
// sessions whose `directory` is that worktree are exactly that task's model calls, failover attempts included.
// One tiny query per worktree (sub-millisecond on a real 35 MB DB), memoized for a few seconds so a burst of fleet
// snapshots touches the DB at most once. Read-only; any failure reads as "not measured" (null), never a guess.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { FleetWorkerTokens } from "@kora/contracts";

const TTL_MS = 10_000;
/** How long a missing / unreadable DB is remembered before looking again. */
const RETRY_MS = 60_000;

export function opencodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(
    env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "opencode",
    "opencode.db",
  );
}

export class SwarmTokenReader {
  private db: DatabaseSync | null = null;
  private stmt: StatementSync | null = null;
  private failedAt = 0;
  private readonly cache = new Map<string, { at: number; value: FleetWorkerTokens | null }>();
  private readonly realpaths = new Map<string, string>();

  private readonly dbPath: string;
  private readonly now: () => number;

  constructor(dbPath: string = opencodeDbPath(), now: () => number = Date.now) {
    this.dbPath = dbPath;
    this.now = now;
  }

  /** The summed tokens of every root OpenCode session run in `worktree`; null when none or unreadable. */
  forWorktree(worktree: string): FleetWorkerTokens | null {
    const t = this.now();
    const hit = this.cache.get(worktree);
    if (hit && t - hit.at < TTL_MS) return hit.value;
    const value = this.query(worktree, t);
    this.cache.set(worktree, { at: t, value });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  private query(worktree: string, t: number): FleetWorkerTokens | null {
    const stmt = this.statement(t);
    if (!stmt) return null;
    try {
      const row = stmt.get(worktree, this.realpath(worktree)) as
        | { n: number; input: number | null; cached: number | null; output: number | null }
        | undefined;
      if (!row || !row.n) return null;
      return {
        input: Math.max(0, Math.trunc(row.input ?? 0)),
        cached: Math.max(0, Math.trunc(row.cached ?? 0)),
        output: Math.max(0, Math.trunc(row.output ?? 0)),
      };
    } catch {
      this.close(t); // schema change / locked / replaced file: reopen later
      return null;
    }
  }

  private statement(t: number): StatementSync | null {
    if (this.stmt) return this.stmt;
    if (t - this.failedAt < RETRY_MS && this.failedAt !== 0) return null;
    try {
      if (!fs.existsSync(this.dbPath)) throw new Error("no opencode db");
      this.db = new DatabaseSync(this.dbPath, { readOnly: true });
      // `input` excludes cache reads; output includes reasoning — the same split `kora swarm usage` reports.
      this.stmt = this.db.prepare(
        `select count(*) as n, sum(tokens_input) as input, sum(tokens_cache_read) as cached,
                sum(tokens_output + tokens_reasoning) as output
           from session where parent_id is null and directory in (?, ?)`,
      );
      return this.stmt;
    } catch {
      this.close(t);
      return null;
    }
  }

  private realpath(p: string): string {
    let r = this.realpaths.get(p);
    if (r === undefined) {
      try {
        r = fs.realpathSync(p);
      } catch {
        r = p;
      }
      this.realpaths.set(p, r);
    }
    return r;
  }

  /** Release the DB handle (the next read reopens it). Windows cannot delete a file a handle is open on. */
  dispose(): void {
    this.close(0);
  }

  private close(t: number): void {
    this.failedAt = t;
    this.stmt = null;
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = null;
  }
}
