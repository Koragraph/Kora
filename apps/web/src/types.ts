import type {
  AccessMode,
  AgentTurnMode,
  ProjectAction as ContractProjectCommand,
  ChatSession,
  ChatPlanProposal,
  ThreadMessage,
  ChatLatestTurn,
  ChatCheckpointSummary,
  ChatCheckpointFile,
  ChatUnknownAttachment as ContractChatUnknownAttachment,
  MessageImageAttachment as ContractChatImageAttachment,
  MessageFileAttachment as ContractChatFileAttachment,
} from "@kora/contracts";
import type { HostProject, HostThread, HostThreadShell } from "@kora/client-runtime/store/shell";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export const DEFAULT_ACCESS_MODE: AccessMode = "full-access";

export const DEFAULT_TURN_MODE: AgentTurnMode = "default";
export const MAX_TERMINALS_PER_GROUP = 4;
export type ProjectAction = ContractProjectCommand;

export interface ThreadTerminalGroup {
  id: string;
  splitDirection?: "horizontal" | "vertical";
  terminalIds: string[];
}

export interface MessageImageAttachment extends ContractChatImageAttachment {
  readonly previewUrl?: string;
}

export interface MessageFileAttachment extends ContractChatFileAttachment {
  readonly previewUrl?: string;
  readonly downloadable?: boolean;
}

// Attachment types this build does not know pass through with the contract
// shape. The UI renders them as inert rows so a newer server cannot crash an
// older client.
export type ChatUnknownAttachment = ContractChatUnknownAttachment;

export type MessageAttachment =
  | MessageImageAttachment
  | MessageFileAttachment
  | ChatUnknownAttachment;

export interface ChatMessage extends Omit<ThreadMessage, "attachments"> {
  readonly attachments?: ReadonlyArray<MessageAttachment> | undefined;
}

export type PlanProposal = ChatPlanProposal;
export type TurnDiffFileChange = ChatCheckpointFile;
export type TurnDiffSummary = ChatCheckpointSummary;

export type Project = HostProject;
export type Thread = HostThread;
export type ThreadShell = HostThreadShell;

export interface ThreadTurnState {
  latestTurn: ChatLatestTurn | null;
}

export type NavThreadSummary = HostThreadShell;
export type ThreadSession = ChatSession;
