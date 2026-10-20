import type { ChatThreadActivity } from "@kora/contracts";

/** One worker row: the lead's proposal, then the user's edit. */
export interface WorkerPickRow {
  title: string;
  agent: string;
  model?: string;
  effort?: string;
  why?: string;
}
export interface WorkerCatalogModel {
  id: string;
  name?: string;
  efforts?: string[];
  isDefault?: boolean;
}
export type WorkerCatalogAgents = Record<
  string,
  { installed: boolean; models: WorkerCatalogModel[] }
>;

export interface PendingWorkerPicker {
  requestId: string;
  picks: WorkerPickRow[];
  catalog: WorkerCatalogAgents;
}

const AGENT_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  antigravity: "Antigravity",
  cursor: "Cursor",
  opencode: "OpenCode",
};
export const agentLabel = (id: string) => AGENT_LABELS[id] ?? id;

function asRows(value: unknown): WorkerPickRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    if (!v || typeof v !== "object") return [];
    const r = v as Record<string, unknown>;
    if (typeof r.agent !== "string" || !r.agent) return [];
    return [
      {
        title: typeof r.title === "string" ? r.title : r.agent,
        agent: r.agent,
        ...(typeof r.model === "string" && r.model ? { model: r.model } : {}),
        ...(typeof r.effort === "string" && r.effort ? { effort: r.effort } : {}),
        ...(typeof r.why === "string" && r.why ? { why: r.why } : {}),
      },
    ];
  });
}

/** The open worker picker for a thread: the newest `worker-picker.requested` that has no `.resolved`. */
export function derivePendingWorkerPicker(
  activities: ReadonlyArray<ChatThreadActivity>,
): PendingWorkerPicker | null {
  const resolved = new Set<string>();
  let open: PendingWorkerPicker | null = null;
  for (const a of activities) {
    const payload = (a.payload ?? {}) as Record<string, unknown>;
    const requestId = typeof payload.requestId === "string" ? payload.requestId : null;
    if (!requestId) continue;
    if (a.kind === "worker-picker.resolved") {
      resolved.add(requestId);
      if (open?.requestId === requestId) open = null;
    } else if (a.kind === "worker-picker.requested" && !resolved.has(requestId)) {
      const catalog =
        payload.catalog && typeof payload.catalog === "object"
          ? (payload.catalog as WorkerCatalogAgents)
          : {};
      open = { requestId, picks: asRows(payload.picks), catalog };
    }
  }
  return open;
}

/** Agents that run on free models (no plan usage); the rest use the user's own plan. */
const FREE_AGENTS = new Set(["opencode", "koragent"]);

export type AgentAvailability = "installed" | "not-installed" | "unknown";

/** Whether this Mac can run the agent: unknown while the catalog is empty (still probing). */
export function agentAvailability(catalog: WorkerCatalogAgents, agent: string): AgentAvailability {
  if (Object.keys(catalog).length === 0) return "unknown";
  return catalog[agent]?.installed ? "installed" : "not-installed";
}

export interface PickerAgentOption {
  id: string;
  /** `Codex · your plan`, `OpenCode · free`, `Codex · not installed`. */
  label: string;
  disabled: boolean;
}

/**
 * The agent select's options: installed agents tagged free or "your plan", plus any the lead proposed (so a proposal
 * never shows an empty select), marked and disabled when not installed. With no catalog yet, only Claude and the
 * proposed agents are offered — never a guess like Codex on a Mac without it.
 */
export function pickerAgentOptions(
  catalog: WorkerCatalogAgents,
  rows: ReadonlyArray<WorkerPickRow>,
): PickerAgentOption[] {
  const installed = Object.entries(catalog)
    .filter(([, a]) => a.installed)
    .map(([id]) => id);
  const ids = installed.length ? installed : Object.keys(catalog).length ? [] : ["claude"];
  for (const r of rows) if (!ids.includes(r.agent)) ids.push(r.agent);
  return ids.map((id) => {
    const availability = agentAvailability(catalog, id);
    const tag =
      availability === "not-installed"
        ? "not installed"
        : FREE_AGENTS.has(id)
          ? "free"
          : "your plan";
    return {
      id,
      label: `${agentLabel(id)} · ${tag}`,
      disabled: availability === "not-installed",
    };
  });
}

/** Rows whose agent this Mac cannot run: the picker warns and will not approve them. */
export function unavailableRows(
  catalog: WorkerCatalogAgents,
  rows: ReadonlyArray<WorkerPickRow>,
): number[] {
  return rows.flatMap((r, i) =>
    agentAvailability(catalog, r.agent) === "not-installed" ? [i] : [],
  );
}

/** True when the human changed the proposal (an edited, removed or reordered row). */
export function rowsEdited(
  proposed: ReadonlyArray<WorkerPickRow>,
  rows: ReadonlyArray<WorkerPickRow>,
): boolean {
  if (proposed.length !== rows.length) return true;
  return rows.some((r, i) => {
    const p = proposed[i]!;
    return (
      r.title !== p.title ||
      r.agent !== p.agent ||
      (r.model ?? "") !== (p.model ?? "") ||
      (r.effort ?? "") !== (p.effort ?? "")
    );
  });
}

export function modelsFor(catalog: WorkerCatalogAgents, agent: string): WorkerCatalogModel[] {
  return catalog[agent]?.models ?? [];
}

/** Effort levels for the row's model (its CLI default model when none is picked). */
export function effortsFor(
  catalog: WorkerCatalogAgents,
  agent: string,
  model: string | undefined,
): string[] {
  const models = modelsFor(catalog, agent);
  const m = model ? models.find((x) => x.id === model) : models.find((x) => x.isDefault);
  return m?.efforts ?? [];
}

/** Change a row's agent or model and keep the rest consistent (a model from another CLI or a missing effort is cleared). */
export function updateRow(
  catalog: WorkerCatalogAgents,
  row: WorkerPickRow,
  patch: Partial<Pick<WorkerPickRow, "agent" | "model" | "effort">>,
): WorkerPickRow {
  const next: WorkerPickRow = { ...row, ...patch };
  if (patch.agent !== undefined && patch.agent !== row.agent) {
    delete next.model;
    delete next.effort;
  }
  if (next.model && !modelsFor(catalog, next.agent).some((m) => m.id === next.model))
    delete next.model;
  const levels = effortsFor(catalog, next.agent, next.model);
  if (next.effort && !levels.includes(next.effort)) delete next.effort;
  if (patch.model === "") delete next.model;
  if (patch.effort === "") delete next.effort;
  return next;
}

/** The answer the daemon expects (SessionManager.answerPicker). */
export function pickerAnswer(rows: ReadonlyArray<WorkerPickRow>, autoApprove: boolean) {
  return {
    picks: rows.map((r) => ({
      title: r.title,
      agent: r.agent,
      ...(r.model ? { model: r.model } : {}),
      ...(r.effort ? { effort: r.effort } : {}),
    })),
    ...(autoApprove ? { autoApprove: true } : {}),
  };
}
