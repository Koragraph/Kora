// Shared state for the transcript's row renderers. The list owner (ThreadTranscript) builds one value of each
// context per render; rows read from them instead of taking props, so a row can sit behind a memo boundary
// and still see fresh callbacks. The clock is deliberately kept out of both: elapsed timers tick themselves.
import type { AgentPanelModel } from "@kora/client-runtime/store/subagentRuntime";
import type { AgentSkill, HostId, HostThreadRef, TurnId } from "@kora/contracts";
import type { CodexArtifactTemplate } from "@kora/client-runtime/codex/artifact-templates";
import { createContext, useContext } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { RefObject } from "react";

import type { ClockFormat } from "@kora/contracts/clientPrefs";
import type { BlobSkin } from "../blobs/chat/blobSkin";
import type { BubbleGroups } from "../blobs/transcript/grouping";
import type { GroupThreadInfo } from "../blobs/groups/groupThreadContext";
import type { ExpandedImageView } from "./ExpandedImageView";
import type { ReplyFootnoteTarget } from "./ReplyFootnoteSource";
import type { WorkGroupScrollAnchor } from "./ThreadTranscript.logic";

/** One open/closed tool-call list: where its scroll was left, and which entries the reader opened. */
export interface WorkGroupView {
  readonly scrollAnchors: Map<string, WorkGroupScrollAnchor>;
  readonly expandedEntryIds: Set<string>;
}

export function createWorkGroupView(): WorkGroupView {
  return { scrollAnchors: new Map(), expandedEntryIds: new Set() };
}

export interface TranscriptInlineErrorState {
  readonly messageId: string;
  readonly onRetry: (() => void) | null;
}

export interface TranscriptShared {
  readonly hostId: HostId;
  readonly threadRef: HostThreadRef | null;
  readonly markdownCwd: string | undefined;
  readonly workspaceRoot: string | undefined;
  readonly resolvedTheme: "light" | "dark";
  readonly timestampFormat: ClockFormat;
  readonly skills: ReadonlyArray<Pick<AgentSkill, "name" | "displayName">>;
  readonly agentPanelModel: AgentPanelModel;
  readonly isAssistantThread: boolean;
  readonly inlineError: TranscriptInlineErrorState | null;
  readonly outputPathsByTurn: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly expandedSpawnEntryIds: ReadonlySet<string>;
  readonly workGroupView: WorkGroupView;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly footnoteTarget: ReplyFootnoteTarget | null;
  readonly blobSkin: BlobSkin | null;
  readonly bubbleGroups: BubbleGroups | null;
  readonly groupThread: GroupThreadInfo | null;
  readonly onImageExpand: (preview: ExpandedImageView) => void;
  readonly onUseArtifactTemplate: (template: CodexArtifactTemplate) => void;
  readonly onOpenFleet: (() => void) | null;
  /** "show all" on a bounded Read: put a request for the whole file into the composer. */
  readonly onAskWholeFile: ((path: string, total: number) => void) | null;
  readonly onSteerQueuedMessage: (id: string) => void;
  readonly onRemoveQueuedMessage: (id: string) => void;
  readonly actions: TranscriptActions;
}

export interface TranscriptActions {
  /**
   * Keep the scroll position of `anchorKey` steady across a disclosure toggle and pause end-following for two
   * frames. `collapsed` marks a toggle that shrank content, so the composer can come back if the list ends up
   * at its end.
   */
  readonly settleDisclosure: (anchorKey: string, collapsed?: boolean) => void;
  readonly toggleTurn: (turnId: TurnId) => void;
  readonly toggleWorkGroup: (groupId: string, rowId: string) => void;
  readonly toggleSpawn: (entryId: string, rowId: string) => void;
}

export interface TranscriptActivity {
  readonly isWorking: boolean;
  readonly isCompacting: boolean;
  readonly latestTurnId: TurnId | null;
  readonly activeTurnStartedAt: string | null;
  /** The reply that currently owns the "resting" lead blob and an always-visible footer. */
  readonly restingMessageId: string | null;
  readonly liveStatusLabel: string | null;
}

export const TranscriptSharedContext = createContext<TranscriptShared | null>(null);
export const TranscriptActivityContext = createContext<TranscriptActivity | null>(null);

export function useTranscriptShared(): TranscriptShared {
  const value = useContext(TranscriptSharedContext);
  if (value === null) throw new Error("Transcript rows must render inside ThreadTranscript.");
  return value;
}

export function useTranscriptActivity(): TranscriptActivity {
  const value = useContext(TranscriptActivityContext);
  if (value === null) throw new Error("Transcript rows must render inside ThreadTranscript.");
  return value;
}
