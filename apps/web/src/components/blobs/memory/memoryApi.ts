// The Memory tab's client API over `blobs.memory.*`. Reads are one-shot commands (the tab refetches after writes and
// on a slow timer); writes are the shared store's commands. Components receive this as a value, so tests pass a fake.
import type {
  BlobEpisodeHit,
  BlobFact,
  BlobMemoryList,
  BlobMemoryScope,
  MemoryReceipt,
} from "@kora/contracts";
import { RPC_METHODS } from "@kora/contracts";
import { createHostRpcCommand } from "@kora/client-runtime/store/runtime";
import { useMemo } from "react";

import { blobsHost as shared } from "~/atoms/blobs";
import { useAtomAction } from "~/atoms/use-atom-command";
import { daemonAtomRuntime } from "~/link/runtime";
import { COMMAND_OPTIONS, useBlobRun, type ApiResult } from "../cards/blobCommand";

const memoryListCommand = createHostRpcCommand(daemonAtomRuntime, {
  label: "blobs:read:memory-list",
  tag: RPC_METHODS.blobsMemoryList,
});
const memorySearchCommand = createHostRpcCommand(daemonAtomRuntime, {
  label: "blobs:read:memory-search",
  tag: RPC_METHODS.blobsMemorySearch,
});

export interface MemoryApi {
  list: (scope: BlobMemoryScope, blobId: string | null) => Promise<ApiResult<BlobMemoryList>>;
  edit: (factId: string, text: string) => Promise<ApiResult<BlobFact>>;
  forget: (factId: string) => Promise<ApiResult<BlobFact>>;
  setImportant: (factId: string, important: boolean) => Promise<ApiResult<BlobFact>>;
  setCore: (
    scope: "you" | "blob",
    blobId: string | null,
    text: string,
  ) => Promise<ApiResult<{ core: string }>>;
  search: (blobId: string, query: string) => Promise<ApiResult<ReadonlyArray<BlobEpisodeHit>>>;
  confirm: (receiptId: string, save: boolean) => Promise<ApiResult<MemoryReceipt>>;
}

export function useMemoryApi(): MemoryApi {
  const { run, hostId } = useBlobRun();
  const list = useAtomAction(memoryListCommand, COMMAND_OPTIONS);
  const search = useAtomAction(memorySearchCommand, COMMAND_OPTIONS);
  const edit = useAtomAction(shared.memoryEdit, COMMAND_OPTIONS);
  const forget = useAtomAction(shared.memoryForget, COMMAND_OPTIONS);
  const important = useAtomAction(shared.memoryImportant, COMMAND_OPTIONS);
  const setCore = useAtomAction(shared.memorySetCore, COMMAND_OPTIONS);
  const confirm = useAtomAction(shared.memoryConfirm, COMMAND_OPTIONS);
  return useMemo<MemoryApi>(
    () => ({
      list: (scope, blobId) =>
        run("Could not load memory.", (h) =>
          list({ hostId: h, input: { scope, blobId, includeRetired: false } }),
        ),
      edit: (factId, text) =>
        run("Could not save that memory.", (h) => edit({ hostId: h, input: { factId, text } })),
      forget: (factId) =>
        run("Could not forget that.", (h) => forget({ hostId: h, input: { factId } })),
      setImportant: (factId, value) =>
        run("Could not change that.", (h) =>
          important({ hostId: h, input: { factId, important: value } }),
        ),
      setCore: (scope, blobId, text) =>
        run("Could not save the notes.", (h) =>
          setCore({ hostId: h, input: { scope, blobId, text } }),
        ),
      search: async (blobId, query) => {
        const result = await run("Search failed.", (h) =>
          search({ hostId: h, input: { blobId, query, limit: 6 } }),
        );
        return result.ok ? { ok: true, value: result.value.episodes } : result;
      },
      confirm: (receiptId, save) =>
        run("Could not save that choice.", (h) =>
          confirm({ hostId: h, input: { receiptId, save } }),
        ),
    }),
    [hostId, run, list, search, edit, forget, important, setCore, confirm],
  );
}
