// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off globalDate:off -- daemon-boundary cache + timers, not an Effect fiber.
// Keeps the per-agent skill lists the composer shows (provider `skills` + a per-folder `workspaceSnapshots` entry)
// current. Discovery itself is in skillDiscovery.ts; this is the cache, the push to open clients, and the lookup the
// send path uses to know which `$name` mentions are real skills.
import * as NodeOS from "node:os";

import type { AgentSkill } from "@kora/contracts";

import { daemonConfig } from "./config.ts";
import { notifyAgentStatusesChanged } from "./modelRefresh.ts";
import { discoverClaudeSkills, probeCodexSkills } from "./skillDiscovery.ts";

type Skill = AgentSkill;
type Provider = (typeof daemonConfig.providers)[number];
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const MAX_SNAPSHOTS = 40;
const STALE_MS = 60_000;

const bySkillCwd = new Map<string, Map<string, Skill[]>>(); // instanceId → cwd → skills
const lastRefresh = new Map<string, number>(); // cwd → epoch ms
let inFlight: Promise<void> | null = null;
const queued = new Set<string>();
let queuedCodex = false;
/** Set once a Codex thread exists in this run: until then Codex's skills are never probed (it is a process spawn). */
let codexWanted = false;

/** Test seam: forget that Codex was ever wanted. */
export function resetCodexWantedForTests(): void {
  codexWanted = false;
}

/** Skills for `driver` ("claude" | "codex") in `cwd`, from the last refresh. Empty until one has landed. */
export function skillsFor(driver: string, cwd: string | null | undefined): ReadonlyArray<Skill> {
  const perCwd = bySkillCwd.get(driver);
  if (!perCwd) return [];
  return (cwd ? perCwd.get(cwd) : undefined) ?? perCwd.get("") ?? [];
}

function providerOf(instanceId: string): Mutable<Provider> | undefined {
  return daemonConfig.providers.find((p) => p.instanceId === instanceId) as
    | Mutable<Provider>
    | undefined;
}

function sameSkills(a: ReadonlyArray<Skill> | undefined, b: ReadonlyArray<Skill>): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

async function runRefresh(cwds: ReadonlyArray<string>, withCodex: boolean): Promise<void> {
  const home = NodeOS.homedir();
  const codex = withCodex ? await probeCodexSkills([home, ...cwds]) : null;
  const checkedAt = new Date().toISOString();
  let changed = false;
  for (const instanceId of ["claude", "codex"] as const) {
    const provider = providerOf(instanceId);
    if (!provider) continue;
    const perCwd = bySkillCwd.get(instanceId) ?? new Map<string, Skill[]>();
    bySkillCwd.set(instanceId, perCwd);
    const forCwd = (cwd: string | null): Skill[] | null =>
      instanceId === "claude" ? discoverClaudeSkills(cwd) : (codex?.get(cwd ?? home) ?? null);

    // A failed Codex probe keeps the last good list rather than blanking the menu.
    const global = forCwd(null);
    if (global) {
      perCwd.set("", global);
      if (!sameSkills(provider.skills, global)) {
        provider.skills = global;
        changed = true;
      }
    }
    const snapshots = [...(provider.workspaceSnapshots ?? [])];
    for (const cwd of cwds) {
      const skills = forCwd(cwd);
      if (!skills) continue;
      perCwd.set(cwd, skills);
      const next = { cwd, checkedAt, slashCommands: provider.slashCommands, skills };
      const at = snapshots.findIndex((s) => s.cwd === cwd);
      if (at >= 0) {
        if (sameSkills(snapshots[at]!.skills, skills)) continue;
        snapshots[at] = next;
      } else {
        snapshots.push(next);
      }
      changed = true;
    }
    if (snapshots.length > MAX_SNAPSHOTS) snapshots.splice(0, snapshots.length - MAX_SNAPSHOTS);
    provider.workspaceSnapshots = snapshots;
  }
  for (const cwd of cwds) lastRefresh.set(cwd, Date.now());
  if (changed) notifyAgentStatusesChanged();
}

/** Re-read the skills for `cwds` (and the user-level ones). Single-flight: calls during a run are folded into the next. */
export function refreshAgentSkills(
  cwds: ReadonlyArray<string> = [],
  withCodex = false,
): Promise<void> {
  if (withCodex) codexWanted = true;
  // The chat-engine tests drive real threads; they must not spawn `codex app-server` or read the developer's ~/.claude.
  if (process.env.NODE_TEST_CONTEXT) return Promise.resolve();
  for (const cwd of cwds) if (cwd) queued.add(cwd);
  if (withCodex) queuedCodex = true;
  if (inFlight) return inFlight;
  const run = async () => {
    try {
      // Loop so folders queued mid-run are not lost.
      do {
        const batch = [...queued];
        const codex = queuedCodex;
        queued.clear();
        queuedCodex = false;
        await runRefresh(batch, codex);
      } while (queued.size > 0);
    } catch (cause) {
      console.warn("[kora-daemon] skill refresh failed:", String(cause));
    } finally {
      inFlight = null;
    }
  };
  inFlight = run();
  return inFlight;
}

/** A folder an agent will work in: refresh its skills unless they are fresh. Fire-and-forget, never throws. */
export function noteSkillCwd(cwd: string | null | undefined, driver?: string): void {
  if (!cwd) return;
  // The first Codex thread of this run is what makes Codex's skill list worth a `codex app-server` spawn.
  if (driver === "codex" && !codexWanted) {
    void refreshAgentSkills([cwd], true);
    return;
  }
  const last = lastRefresh.get(cwd);
  if (last !== undefined && Date.now() - last < STALE_MS) return;
  void refreshAgentSkills([cwd]);
}

const WATCH_MS = 15_000;
const CODEX_EVERY_TICKS = 40; // Codex is a process spawn (every ~10 min, and only once a Codex thread exists); Claude's is a few directory reads
let watcher: ReturnType<typeof setInterval> | null = null;

/**
 * Skills are plain files people add and edit while Kora is open, so re-read them on a timer: the folders threads use
 * every 15s (cheap directory reads, pushed to clients only when something changed), Codex's list every ~10 minutes once a Codex thread exists.
 */
export function startSkillWatcher(): void {
  if (watcher || process.env.NODE_TEST_CONTEXT) return;
  let tick = 0;
  watcher = setInterval(() => {
    tick++;
    void refreshAgentSkills([...lastRefresh.keys()], codexWanted && tick % CODEX_EVERY_TICKS === 0);
  }, WATCH_MS);
  watcher.unref?.();
}
