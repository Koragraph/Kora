// The wired versions of the Phase 2 cards: roster outfits, thread navigation and daemon actions come from hooks here,
// so JobCard / ProposalCard stay pure (and testable). BlobCardRow mounts these for `job` and `proposal` cards.
import type { BlobDraft } from "@kora/contracts";
import { hostThreadRef } from "@kora/client-runtime/host";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { usePrimaryHostId } from "~/atoms/hosts";
import type { BlobOutfit } from "~/components/blobs/avatar";
import { CHIEF_BLOB_ID } from "@kora/contracts";
import { usePromptDraftStore } from "~/stores/promptDraftStore";
import { threadPageParams, resolveThreadPageRef } from "~/thread/threadRoutes";
import { BlobEditorDialog } from "../editor/BlobEditorDialog";
import type { BlobCardRef } from "../../../thread/timeline";
import { toAvatarOutfit } from "../outfit";
import { useBlobsState } from "../shell/blobsApi";
import { useBlobApprovals } from "./ApprovalCard";
import { JobCard } from "./JobCard";
import type { JobView, StepView } from "./jobModel";
import { ConfirmCard } from "./ConfirmCard";
import { ProposalCard } from "./ProposalCard";
import { useConfirmActions, useJobActions, useProposalActions } from "./teamCardActions";

export function JobCardRow(props: {
  readonly card: BlobCardRef;
  /** Prefill Kora's composer to change a step that has not started. Default: the open thread's composer. */
  readonly onEditStep?: (job: JobView, step: StepView) => void;
  readonly onOpenOutput?: (path: string) => void;
}) {
  const params = useParams({ strict: false }) as { hostId?: string; threadId?: string };
  const threadRef = resolveThreadPageRef(params);
  const editStep = useCallback(
    (_job: JobView, step: StepView) => {
      if (!threadRef) return;
      const store = usePromptDraftStore.getState();
      const current = store.getComposerDraft(threadRef)?.prompt ?? "";
      const line = `Change step "${step.title}" (${step.blobName}) to: `;
      store.setPrompt(threadRef, current.trim() ? `${current.trimEnd()}\n${line}` : line);
    },
    [threadRef],
  );

  const actions = useJobActions();
  // The thread view says whether this thread runs a turn (Kora's, while she combines the steps' answers).
  const koraWorking = useBlobApprovals()?.live === true;
  const router = useRouter();
  const hostId = usePrimaryHostId();
  const { snapshot } = useBlobsState();
  const blobs = snapshot?.blobs;

  const outfitFor = useCallback(
    (blobId: string, blobName: string): BlobOutfit => {
      const blob =
        blobs?.find((b) => b.id === blobId) ??
        blobs?.find((b) => b.archivedAt === null && b.name === blobName);
      return toAvatarOutfit(
        blob?.outfit ?? null,
        blob?.id ?? blobId,
        (blob?.id ?? blobId) === CHIEF_BLOB_ID,
      );
    },
    [blobs],
  );

  const openThread = useCallback(
    (threadId: string) => {
      if (hostId === null) return;
      void router.navigate({
        to: "/$hostId/$threadId",
        params: threadPageParams(hostThreadRef(hostId, threadId as never)),
      });
    },
    [hostId, router],
  );

  return (
    <JobCard
      card={props.card}
      actions={actions}
      outfitFor={outfitFor}
      onOpenThread={openThread}
      koraWorking={koraWorking}
      {...(props.onEditStep
        ? { onEditStep: props.onEditStep }
        : threadRef
          ? { onEditStep: editStep }
          : {})}
      {...(props.onOpenOutput ? { onOpenOutput: props.onOpenOutput } : {})}
    />
  );
}

export function ProposalCardRow(props: {
  readonly card: BlobCardRef;
  /** Override: open the editor yourself. Default: this row opens the editor pre-filled (Tweak). */
  readonly onTweak?: (draft: BlobDraft, proposalId: string) => void;
}) {
  const actions = useProposalActions();
  const stable = useMemo(() => actions, [actions]);
  const [tweak, setTweak] = useState<{ draft: BlobDraft; proposalId: string } | null>(null);
  const onTweak =
    props.onTweak ?? ((draft: BlobDraft, proposalId: string) => setTweak({ draft, proposalId }));
  return (
    <>
      <ProposalCard card={props.card} actions={stable} onTweak={onTweak} />
      {tweak ? (
        <BlobEditorDialog
          open
          blobId={null}
          initialDraft={tweak.draft}
          proposalId={tweak.proposalId}
          onOpenChange={(open) => {
            if (!open) setTweak(null);
          }}
        />
      ) : null}
    </>
  );
}

export function ConfirmCardRow(props: { readonly card: BlobCardRef }) {
  const actions = useConfirmActions();
  return <ConfirmCard card={props.card} actions={actions} />;
}
