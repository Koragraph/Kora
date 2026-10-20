import { hostThreadKey } from "@kora/client-runtime/host";
import {
  DEFAULT_THREAD_AGENT_MODE,
  type HostThreadRef,
  type ThreadAgentMode,
} from "@kora/contracts";

import type { DraftId } from "./promptDraftStore";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../util/storage";

/**
 * The composer's agent-mode choice for threads that do not exist on the server yet
 * (drafts). Once a thread is created its `agentMode` lives on the server thread and the
 * command `setThreadAgentMode` changes it; this store only bridges the draft.
 *
 * It also keeps the one agent-mode preference: which kind of Team the composer's Chat | Team toggle
 * switches to (Swarm: free-model workers; Orchestrator: Claude/Codex CLI workers), last one used.
 */
export type TeamAgentMode = Extract<ThreadAgentMode, "swarm" | "orchestrator">;

interface AgentModeState {
  byKey: Record<string, ThreadAgentMode>;
  teamKind: TeamAgentMode;
  setTeamKind: (kind: TeamAgentMode) => void;
  set: (target: HostThreadRef | DraftId, mode: ThreadAgentMode) => void;
  clear: (target: HostThreadRef | DraftId) => void;
}

function agentModeKey(target: HostThreadRef | DraftId): string {
  return typeof target === "string" ? `draft:${target}` : hostThreadKey(target);
}

export const useAgentModeStore = create<AgentModeState>()(
  persist(
    (set) => ({
      byKey: {},
      teamKind: "swarm",
      setTeamKind: (kind) => set((state) => (state.teamKind === kind ? state : { teamKind: kind })),
      set: (target, mode) =>
        set((state) => {
          const key = agentModeKey(target);
          if (mode === DEFAULT_THREAD_AGENT_MODE) {
            if (!(key in state.byKey)) return state;
            const next = { ...state.byKey };
            delete next[key];
            return { byKey: next };
          }
          if (state.byKey[key] === mode) return state;
          return { byKey: { ...state.byKey, [key]: mode } };
        }),
      clear: (target) =>
        set((state) => {
          const key = agentModeKey(target);
          if (!(key in state.byKey)) return state;
          const next = { ...state.byKey };
          delete next[key];
          return { byKey: next };
        }),
    }),
    {
      name: "kora:prompt-agent-mode:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byKey: state.byKey, teamKind: state.teamKind }),
    },
  ),
);

export function selectDraftAgentMode(
  state: AgentModeState,
  target: HostThreadRef | DraftId | null,
): ThreadAgentMode | null {
  if (target === null) return null;
  return state.byKey[agentModeKey(target)] ?? null;
}
