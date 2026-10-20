import { migrateLegacyAgentId } from "@kora/contracts";

// Re-hydrating a persisted chat-thread PROJECTION (the UI read model) after a daemon restart: settle a turn that died
// with the previous process, drop transient in-flight state, and back-fill fields older records lack.
//
// The two runtime replays that used to live here moved into the daemon, where the state is owned (and tested in
// kora/src/session/session-manager.test.ts):
//   1. the permission mode is persisted on the kora thread head by SessionManager.setPermissionMode and read back at
//      session start — a hydrated thread can no longer fall back to approval-required behind a "Bypass" pill;
//   2. graph freshness runs at EVERY session start, resume included (ManagerRuntime.graph.ensureFresh).

/** What a persisted record must carry for hydration; the real ThreadRecord is a superset. */
export interface HydratableRecord {
  threadId: string;
  koraThreadId: string;
  cwd: string;
  runtimeMode: string;
  session?: { status?: string; providerName?: string } | null;
  latestTurn?: { state?: string } | null;
  currentAssistant?: unknown;
  koraSessionId?: string | null;
  providerDriver?: string;
  agentMode?: string;
  pendingNotes?: unknown[];
  leaderLimit?: unknown;
  digestNext?: boolean;
  activities: Array<{ sequence?: number }>;
}

const AGENT_MODES: ReadonlySet<string> = new Set(["chat", "orchestrator", "swarm"]);
/** Map a runtimeMode → the kora PermissionMode the composer picks. */
export function toPermissionMode(accessMode: string): string {
  switch (accessMode) {
    case "full-access":
    case "auto":
    case "auto-accept-edits":
      return accessMode;
    default:
      return "supervised"; // approval-required
  }
}

/**
 * Requests (approvals, questions, worker picks) a persisted thread still shows as open. After a restart nothing is parked on
 * them any more, so the caller closes them: left open, the thread read "needs you" for ever and its card kept offering buttons
 * that answer nothing.
 */
export function openRequests(activities: ReadonlyArray<{ kind?: string; payload?: unknown }>): {
  approvals: string[];
  userInputs: string[];
  pickers: string[];
} {
  const open = { approval: new Set<string>(), input: new Set<string>(), picker: new Set<string>() };
  const idOf = (p: unknown): string | null => {
    const id = p && typeof p === "object" ? (p as { requestId?: unknown }).requestId : null;
    return typeof id === "string" && id ? id : null;
  };
  for (const a of activities) {
    const id = idOf(a.payload);
    if (!id) continue;
    switch (a.kind) {
      case "approval.requested":
        open.approval.add(id);
        break;
      case "approval.resolved":
        open.approval.delete(id);
        break;
      case "user-input.requested":
        open.input.add(id);
        break;
      case "user-input.resolved":
        open.input.delete(id);
        break;
      case "worker-picker.requested":
        open.picker.add(id);
        break;
      case "worker-picker.resolved":
        open.picker.delete(id);
        break;
      default:
        break;
    }
  }
  return { approvals: [...open.approval], userInputs: [...open.input], pickers: [...open.picker] };
}

/**
 * Normalise one persisted record in place. Returns whether the record was persisted mid-turn (the turn died with
 * the previous daemon; the caller settles it so the client never shows a spinner "for 7h 41m") and the highest
 * activity sequence it carries.
 */
export function hydrateRecord<T extends HydratableRecord>(
  rec: T,
): {
  interrupted: boolean;
  maxSeq: number;
} {
  const interrupted = rec.session?.status === "running" || rec.latestTurn?.state === "running";
  rec.currentAssistant = null; // transient in-flight state never persists
  if (rec.koraSessionId === undefined) rec.koraSessionId = null; // back-compat for old records
  // Legacy records were Claude; the Claude driver id was `claudeAgent` before it took the kora agent id
  // `claude`. The client locks the provider picker to `session.providerName`, which must equal the provider
  // entry's `driver`, so both copies are migrated.
  rec.providerDriver = migrateLegacyAgentId(rec.providerDriver ?? "claude");
  if (rec.session?.providerName !== undefined)
    rec.session.providerName = migrateLegacyAgentId(rec.session.providerName);
  // A record from before the orchestrator toggle has no mode (chat). chat | orchestrator | swarm are kept; an
  // unknown mode (a newer daemon's record) reads as orchestrator — the wire decode's leniency
  // (contracts `LenientThreadAgentMode`).
  if (rec.agentMode === undefined) rec.agentMode = "chat";
  else if (!AGENT_MODES.has(rec.agentMode)) rec.agentMode = "orchestrator";
  // Pending worker notes are in-memory and go stale across a restart — except a human STOP (kora-chat persists only
  // those), which the lead must still hear on its next turn.
  rec.pendingNotes = (Array.isArray(rec.pendingNotes) ? rec.pendingNotes : []).filter(
    (n) => !!n && typeof n === "object" && (n as { kind?: unknown }).kind === "stopped",
  );
  // The leader's rate-limit window and a pending digest are in-memory timers; they never survive a restart.
  delete rec.leaderLimit;
  delete rec.digestNext;
  let maxSeq = 0;
  for (const a of rec.activities)
    if (a.sequence !== undefined && a.sequence > maxSeq) maxSeq = a.sequence;
  return { interrupted, maxSeq };
}
