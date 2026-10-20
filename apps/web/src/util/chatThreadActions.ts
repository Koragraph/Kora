import type { HostId, ModelPick, ProjectId, HostProjectRef } from "@kora/contracts";
import type { PromptThreadDraftState, DraftThreadEnvMode } from "../stores/promptDraftStore";

type PromptModelPickState = Pick<
  PromptThreadDraftState,
  "activeProvider" | "modelSelectionByProvider" | "modelSelectionExplicit"
>;

interface ThreadContextLike {
  hostId: HostId;
  projectId: ProjectId;
}

interface NewThreadHandler {
  (
    projKey: HostProjectRef,
    opts?: {
      startFromOrigin?: boolean;
      envMode?: DraftThreadEnvMode;
      worktreePath?: string | null;
      branch?: string | null;
    },
    // The opened draft's identity, which most callers have no use for.
  ): Promise<unknown>;
}

export interface ChatThreadActionContext {
  readonly openNewThread: NewThreadHandler;
  readonly defaultProjectRef: HostProjectRef | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly activeDraftThread: ThreadContextLike | null;
}

export function resolveNewDraftStartFromOrigin(args: {
  newWorktreesStartFromOrigin: boolean;
  envMode: DraftThreadEnvMode;
}): boolean {
  return args.envMode === "worktree" && args.newWorktreesStartFromOrigin;
}

export function resolveNewThreadModelPickOverride(args: {
  readonly projectDefaultSelection: ModelPick | null;
  readonly carrySelection: ModelPick | null;
  readonly carrySourceDraftId: string | null;
  readonly destinationDraftId: string;
}): ModelPick | null {
  return (
    args.projectDefaultSelection ??
    (args.carrySourceDraftId === args.destinationDraftId ? null : args.carrySelection)
  );
}

export function hasExplicitPromptModelPick(
  draft: PromptModelPickState | null | undefined,
): boolean {
  const activeAgent = draft?.activeProvider;
  return (
    draft?.modelSelectionExplicit === true &&
    activeAgent !== null &&
    activeAgent !== undefined &&
    draft.modelSelectionByProvider[activeAgent] !== undefined
  );
}
