// What the Phase 2 cards can do: hire / dismiss a proposal, cancel / give feedback on a job. Same shape as
// cardActions.ts (one hook so tests mock a single module), kept in its own file beside it.
import type { BlobDraft, BlobProfile } from "@kora/contracts";

import { blobsHost } from "~/atoms/blobs";
import { useAtomAction } from "~/atoms/use-atom-command";
import { COMMAND_OPTIONS, useBlobRun, type ApiResult } from "./blobCommand";

export interface ProposalActions {
  /** `blobs.create({ draft, proposalId })`: creates the blob and flips the proposal card to `hired`. */
  hire: (draft: BlobDraft, proposalId: string) => Promise<ApiResult<BlobProfile>>;
  /** `blobs.proposal.dismiss`: the card flips to `dismissed`. */
  dismiss: (proposalId: string) => Promise<ApiResult<object>>;
}

export interface JobActions {
  /** `blobs.job.cancel` with `stepId: null`; resolves the next job card payload. */
  /** `blobs.job.get`: the job's current card. A transcript card can be an old snapshot, so a live-looking card re-reads it. */
  refresh?: (jobId: string) => Promise<ApiResult<Record<string, unknown>>>;
  cancelJob: (jobId: string) => Promise<ApiResult<Record<string, unknown>>>;
  cancelStep: (jobId: string, stepId: string) => Promise<ApiResult<Record<string, unknown>>>;
  feedback: (
    jobId: string,
    stepId: string,
    reaction: "good" | "redo",
  ) => Promise<ApiResult<object>>;
}

export function useProposalActions(): ProposalActions {
  const { run } = useBlobRun();
  const create = useAtomAction(blobsHost.create, COMMAND_OPTIONS);
  const dismiss = useAtomAction(blobsHost.proposalDismiss, COMMAND_OPTIONS);
  return {
    hire: (draft, proposalId) =>
      run("Could not hire them. Try again in a moment.", (hostId) =>
        create({ hostId, input: { draft, proposalId } }),
      ),
    dismiss: (proposalId) =>
      run("Could not dismiss that.", (hostId) => dismiss({ hostId, input: { proposalId } })),
  };
}

export function useJobActions(): JobActions {
  const { run } = useBlobRun();
  const cancel = useAtomAction(blobsHost.jobCancel, COMMAND_OPTIONS);
  const feedback = useAtomAction(blobsHost.jobFeedback, COMMAND_OPTIONS);
  const get = useAtomAction(blobsHost.jobGet, COMMAND_OPTIONS);
  return {
    refresh: (jobId) =>
      run("Could not refresh the job.", (hostId) => get({ hostId, input: { jobId } })) as Promise<
        ApiResult<Record<string, unknown>>
      >,
    cancelJob: (jobId) =>
      run("Could not cancel the job.", (hostId) =>
        cancel({ hostId, input: { jobId, stepId: null } }),
      ) as Promise<ApiResult<Record<string, unknown>>>,
    cancelStep: (jobId, stepId) =>
      run("Could not cancel that step.", (hostId) =>
        cancel({ hostId, input: { jobId, stepId } }),
      ) as Promise<ApiResult<Record<string, unknown>>>,
    feedback: (jobId, stepId, reaction) =>
      run("Could not save that.", (hostId) =>
        feedback({ hostId, input: { jobId, stepId, reaction } }),
      ),
  };
}

export interface ConfirmCardActions {
  /** `blobs.confirm.resolve`: the answer to Kora's confirm card. */
  resolve: (
    cardId: string,
    accept: boolean,
  ) => Promise<ApiResult<{ ok: boolean; message: string }>>;
}

export function useConfirmActions(): ConfirmCardActions {
  const { run } = useBlobRun();
  const resolve = useAtomAction(blobsHost.confirmResolve, COMMAND_OPTIONS);
  return {
    resolve: (cardId, accept) =>
      run("Could not answer that. Try again in a moment.", (hostId) =>
        resolve({ hostId, input: { cardId, accept } }),
      ),
  };
}
