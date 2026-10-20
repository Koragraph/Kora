import type { HostId, ChatProjectHead, ChatThreadHead, ThreadId } from "@kora/contracts";

export type AgentAwarenessPhase =
  | "stale"
  | "failed"
  | "completed"
  | "running"
  | "starting"
  | "waiting_for_input"
  | "waiting_for_approval";

interface AwarenessThreadRef {
  readonly threadTitle: string;
  readonly deepLink: string;
  readonly hostId: HostId;
  readonly projectTitle: string;
  readonly threadId: ThreadId;
}

export interface AgentAwarenessState extends AwarenessThreadRef {
  readonly updatedAt: string;
  readonly headline: string;
  readonly modelTitle: string;
  readonly phase: AgentAwarenessPhase;
  readonly detail?: string;
}

type AwarenessThreadFields =
  | "id"
  | "title"
  | "updatedAt"
  | "modelSelection"
  | "hasPendingUserInput"
  | "hasPendingApprovals"
  | "latestTurn"
  | "session";

export interface ProjectThreadAwarenessInput {
  readonly thread: Pick<ChatThreadHead, AwarenessThreadFields>;
  readonly project: Pick<ChatProjectHead, "title">;
  readonly hostId: HostId;
}
