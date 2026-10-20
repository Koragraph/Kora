// What the transcript cards can do: undo / confirm a memory receipt, undo a self-change, continue a rate-limited
// thread on a free model. One hook so tests mock a single module.
import type { MemoryReceipt } from "@kora/contracts";

import { blobsHost } from "~/atoms/blobs";
import { useAtomAction } from "~/atoms/use-atom-command";
import { COMMAND_OPTIONS, useBlobRun, type ApiResult } from "./blobCommand";

export interface BlobCardActions {
  /** Undo a memory receipt; resolves the receipt as it now stands (`undone: true`). */
  undoMemory: (receiptId: string) => Promise<ApiResult<MemoryReceipt>>;
  /** Approve (save) or decline a held memory. */
  confirmMemory: (receiptId: string, save: boolean) => Promise<ApiResult<MemoryReceipt>>;
  /** Undo a self-change receipt (SOUL / model edits the blob made): `blobs.selfChange.undo` with the card's `undoToken`. */
  undoSelfChange: (undoToken: string) => Promise<ApiResult<{ undone: boolean }>>;
  /** Start a new thread on a free model carrying on from the rate-limited one; resolves the new thread id. */
  continueOnFree: (threadId: string) => Promise<ApiResult<{ threadId: string }>>;
}

export function useBlobCardActions(): BlobCardActions {
  const { run } = useBlobRun();
  const memoryUndo = useAtomAction(blobsHost.memoryUndo, COMMAND_OPTIONS);
  const memoryConfirm = useAtomAction(blobsHost.memoryConfirm, COMMAND_OPTIONS);
  const undoSelfChangeCmd = useAtomAction(blobsHost.undoSelfChange, COMMAND_OPTIONS);
  const continueOnFree = useAtomAction(blobsHost.continueOnFree, COMMAND_OPTIONS);
  return {
    undoMemory: (receiptId) =>
      run("Could not undo that.", (hostId) => memoryUndo({ hostId, input: { receiptId } })),
    confirmMemory: (receiptId, save) =>
      run("Could not save that choice.", (hostId) =>
        memoryConfirm({ hostId, input: { receiptId, save } }),
      ),
    undoSelfChange: (undoToken) =>
      run("Could not undo that change.", (hostId) =>
        undoSelfChangeCmd({ hostId, input: { token: undoToken } }),
      ),
    continueOnFree: (threadId) =>
      run("Could not continue on a free model.", (hostId) =>
        continueOnFree({ hostId, input: { threadId } }),
      ),
  };
}
