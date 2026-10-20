// Memory: what this blob (and every blob) knows about you, by group, with dates and sources. Edit inline, star what
// matters, forget with an Undo toast, approve what was held for your OK, edit the always-on core notes. The tab itself
// only connects data to `MemoryView`; see components/blobs/memory/.
import { hostThreadRef } from "@kora/client-runtime/host";
import type { BlobEpisodeHit, BlobFact, ThreadId } from "@kora/contracts";
import { CHIEF_BLOB_ID } from "@kora/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";

import { usePrimaryHostId } from "~/atoms/hosts";
import { toastManager } from "~/components/ui/toast";
import { threadPageParams } from "~/thread/threadRoutes";
import { resolveHeldMemory, useHeldMemories } from "../memory/heldStore";
import { useMemoryApi } from "../memory/memoryApi";
import { describeExtractor } from "../memory/memoryModel";
import { MemoryView } from "../memory/MemoryView";
import { useBlobMemory } from "../memory/useBlobMemory";
import { useBlobsState } from "../shell/blobsApi";
import { useBlobRoster } from "../shell/useBlobRoster";

const FORGET_TOAST_CHARS = 80;

export function MemoryTab(props: { readonly blobId: string }) {
  const { blobId } = props;
  const api = useMemoryApi();
  const router = useRouter();
  const hostId = usePrimaryHostId();
  const { snapshot } = useBlobsState();
  const { entries } = useBlobRoster();
  const blobName = entries.get(blobId)?.blob.name ?? "This blob";
  const controller = useBlobMemory(api, blobId, { includeTeam: blobId === CHIEF_BLOB_ID });
  const held = useHeldMemories(blobId);
  const extractor = useMemo(
    () =>
      describeExtractor(
        snapshot?.engines ?? null,
        snapshot?.memoryModel ?? null,
        snapshot?.flags.claudeMemoryFallback === true,
      ),
    [snapshot?.engines, snapshot?.memoryModel, snapshot?.flags.claudeMemoryFallback],
  );

  useEffect(() => {
    if (controller.lastError) {
      toastManager.add({ type: "error", title: "Memory", description: controller.lastError });
    }
  }, [controller.lastError]);

  const openSource = useCallback(
    (threadId: string) => {
      if (hostId === null) return;
      void router.navigate({
        to: "/$hostId/$threadId",
        params: threadPageParams(hostThreadRef(hostId, threadId as ThreadId)),
      });
    },
    [hostId, router],
  );

  const forget = useCallback(
    (fact: BlobFact) => {
      controller.forget(fact, ({ undo }) => {
        const text =
          fact.text.length > FORGET_TOAST_CHARS
            ? `${fact.text.slice(0, FORGET_TOAST_CHARS - 1)}…`
            : fact.text;
        const id = toastManager.add({
          title: "Forgotten",
          description: text,
          timeout: 6000,
          actionProps: {
            children: "Undo",
            onClick: () => {
              undo();
              toastManager.close(id);
            },
          },
        });
      });
    },
    [controller],
  );

  const resolveHeld = useCallback(
    async (receiptId: string, save: boolean): Promise<string | null> => {
      const result = await api.confirm(receiptId, save);
      if (!result.ok) return result.message;
      resolveHeldMemory(receiptId);
      if (save) controller.refresh();
      return null;
    },
    [api, controller],
  );

  const searchEpisodes = useCallback(
    async (query: string): Promise<ReadonlyArray<BlobEpisodeHit>> => {
      const result = await api.search(blobId, query);
      return result.ok ? result.value : [];
    },
    [api, blobId],
  );

  return (
    <MemoryView
      blobName={blobName}
      controller={controller}
      held={held}
      onResolveHeld={resolveHeld}
      extractor={extractor}
      onOpenSource={openSource}
      onForget={forget}
      searchEpisodes={searchEpisodes}
    />
  );
}
