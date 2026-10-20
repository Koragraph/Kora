// Dispatcher for a `blob.card` transcript row. The card is already the highest version of its cardId (session-logic);
// this picks the renderer by `cardKind`. Memory and self-change receipts are one quiet line; the rate-limit card is
// the one with a button; Phase 2 cards (job, proposal, confirm) are the real team cards.
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { hostThreadRef } from "@kora/client-runtime/host";
import { usePrimaryHostId } from "~/atoms/hosts";
import { useAllHostShellsBootstrapped, useThreadSummary } from "~/atoms/entities";
import { threadPageParams } from "~/thread/threadRoutes";
import { AppConnectCard } from "../apps/AppConnectCard";
import { useBlobSkin } from "../chat/blobSkin";
import { RoutineConfirmCard, RoutineReportCard } from "../routines/RoutineReportCard";
import type { BlobCardRef } from "../../../thread/timeline";
import { ApprovalCard } from "./ApprovalCard";
import { HelpersRow } from "./HelpersRow";
import { useBlobCardActions } from "./cardActions";
import { MemoryReceiptCard } from "./MemoryReceiptCard";
import { parseBlobCard } from "./parseCard";
import { ConfirmCardRow, JobCardRow, ProposalCardRow } from "./Phase2CardRows";
import { UnknownCard } from "./PlaceholderCards";
import { RateLimitCard } from "./RateLimitCard";
import { SelfChangeCard } from "./SelfChangeCard";

export function BlobCardRow(props: { readonly card: BlobCardRef; readonly label: string }) {
  const parsed = useMemo(() => parseBlobCard(props.card), [props.card]);
  const actions = useBlobCardActions();
  const router = useRouter();
  const hostId = usePrimaryHostId();
  const blobId = useBlobSkin()?.blobId ?? null;
  // A routine run's hidden thread may have been cleaned up (retention): only then does Open run go away.
  const runThread = parsed.kind === "routine-report" ? parsed.card.executionThreadId : null;
  const runShell = useThreadSummary(
    hostId !== null && runThread ? hostThreadRef(hostId, runThread as never) : null,
  );
  const shellsReady = useAllHostShellsBootstrapped();
  const runKept = runThread === null ? undefined : shellsReady ? runShell !== null : undefined;

  const continueOnFree = useCallback(
    async (threadId: string) => {
      const result = await actions.continueOnFree(threadId);
      if (!result.ok) return { ok: false as const, message: result.message };
      if (hostId !== null) {
        void router.navigate({
          to: "/$hostId/$threadId",
          params: threadPageParams(hostThreadRef(hostId, result.value.threadId as never)),
        });
      }
      return { ok: true as const };
    },
    [actions, hostId, router],
  );

  switch (parsed.kind) {
    case "memory":
      return <MemoryReceiptCard receipts={parsed.receipts} actions={actions} blobId={blobId} />;
    case "self-change":
      return (
        <SelfChangeCard
          what={parsed.what}
          undoToken={parsed.undoToken}
          undone={parsed.undone}
          actions={actions}
        />
      );
    case "rate-limit":
      return (
        <RateLimitCard
          engine={parsed.engine}
          resetsAt={parsed.resetsAt}
          onContinue={() => continueOnFree(parsed.threadId)}
        />
      );
    case "approval":
      return <ApprovalCard card={props.card} />;
    case "helpers":
      return <HelpersRow card={props.card} />;
    case "job":
      return <JobCardRow card={props.card} />;
    case "proposal":
      return <ProposalCardRow card={props.card} />;
    case "confirm":
      return <ConfirmCardRow card={props.card} />;
    case "routine-report":
      return (
        <RoutineReportCard
          card={parsed.card}
          runKept={runKept}
          onOpenRun={(threadId) => {
            if (hostId !== null)
              void router.navigate({
                to: "/$hostId/$threadId",
                params: threadPageParams(hostThreadRef(hostId, threadId as never)),
              });
          }}
        />
      );
    case "routine-confirm":
      return <RoutineConfirmCard card={parsed.card} />;
    case "app-connect":
      return (
        <AppConnectCard
          toolkit={parsed.toolkit}
          reason={parsed.reason}
          blobId={parsed.blobId || (blobId ?? "")}
        />
      );
    case "unknown":
      return <UnknownCard label={props.label} />;
  }
}
