import { useAtomAction } from "~/atoms/use-atom-command";
import { useHostQuery } from "~/atoms/query";
import { usePrimaryHostId } from "~/atoms/hosts";
import { blobsHost } from "./blobsHost";
// The Blobs surface's client API: the live roster snapshot and promise-returning actions over `blobs.*`.
// Components never touch atoms directly, so tests can mock this module and B's store can replace blobsHost.
import type {
  BlobProfilePatch,
  BlobsSnapshot,
  BlobDefaults,
  BlobFlagKey,
  BlobProfile,
  BlobDetail,
  BlobDraft,
  BlobFiles,
  BlobUsage,
  HostId,
} from "@kora/contracts";
import {
  isAtomActionInterrupted,
  type AtomActionResult,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import { useCallback, useMemo } from "react";

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const COMMAND_OPTIONS = { reportFailure: false } as const;

function settle<A, E>(result: AtomActionResult<A, E>, fallback: string): ApiResult<A> {
  if (result._tag === "Success") return { ok: true, value: result.value };
  if (isAtomActionInterrupted(result)) return { ok: false, message: "Cancelled." };
  const failure = squashAtomActionFailure(result);
  const message =
    failure instanceof Error && failure.message.trim().length > 0 ? failure.message : fallback;
  return { ok: false, message };
}

export interface BlobsState {
  readonly hostId: HostId | null;
  /** null until the first frame of `blobs.subscribe` (or on a daemon that predates Blobs). */
  readonly snapshot: BlobsSnapshot | null;
  readonly error: string | null;
}

/** The live roster. Every consumer shares one subscription (atom family, 60 s idle TTL). */
export function useBlobsState(): BlobsState {
  const hostId = usePrimaryHostId();
  const query = useHostQuery(hostId === null ? null : blobsHost.roster({ hostId, input: {} }));
  return { hostId, snapshot: query.data?.snapshot ?? null, error: query.error };
}

export interface BlobsApi {
  readonly hostId: HostId | null;
  /** `proposalId` set = a Tweaked proposal card: the daemon flips that card to hired. */
  create: (draft: BlobDraft, proposalId?: string | null) => Promise<ApiResult<BlobProfile>>;
  update: (blobId: string, patch: BlobProfilePatch) => Promise<ApiResult<BlobProfile>>;
  setSoul: (blobId: string, text: string) => Promise<ApiResult<BlobDetail>>;
  archive: (blobId: string) => Promise<ApiResult<BlobProfile>>;
  rehire: (blobId: string) => Promise<ApiResult<BlobProfile>>;
  duplicate: (blobId: string) => Promise<ApiResult<BlobProfile>>;
  remove: (blobId: string, confirmName: string) => Promise<ApiResult<object>>;
  get: (blobId: string) => Promise<ApiResult<BlobDetail>>;
  usage: (blobId: string) => Promise<ApiResult<BlobUsage>>;
  files: (blobId: string, since: number | null) => Promise<ApiResult<BlobFiles>>;
  getAboutMe: () => Promise<ApiResult<string>>;
  setAboutMe: (text: string) => Promise<ApiResult<string>>;
  getDefaults: () => Promise<ApiResult<BlobDefaults>>;
  setDefaults: (defaults: BlobDefaults) => Promise<ApiResult<BlobDefaults>>;
  setFlag: (key: BlobFlagKey, value: boolean) => Promise<ApiResult<object>>;
}

const NO_HOST: ApiResult<never> = { ok: false, message: "Kora is not connected." };

export function useBlobsApi(): BlobsApi {
  const hostId = usePrimaryHostId();
  const create = useAtomAction(blobsHost.create, COMMAND_OPTIONS);
  const update = useAtomAction(blobsHost.update, COMMAND_OPTIONS);
  const setSoul = useAtomAction(blobsHost.setSoul, COMMAND_OPTIONS);
  const archive = useAtomAction(blobsHost.archive, COMMAND_OPTIONS);
  const rehire = useAtomAction(blobsHost.rehire, COMMAND_OPTIONS);
  const duplicate = useAtomAction(blobsHost.duplicate, COMMAND_OPTIONS);
  const remove = useAtomAction(blobsHost.remove, COMMAND_OPTIONS);
  const get = useAtomAction(blobsHost.get, COMMAND_OPTIONS);
  const usage = useAtomAction(blobsHost.usage, COMMAND_OPTIONS);
  const files = useAtomAction(blobsHost.files, COMMAND_OPTIONS);
  const getAboutMe = useAtomAction(blobsHost.getAboutMe, COMMAND_OPTIONS);
  const setAboutMe = useAtomAction(blobsHost.setAboutMe, COMMAND_OPTIONS);
  const getDefaults = useAtomAction(blobsHost.getDefaults, COMMAND_OPTIONS);
  const setDefaults = useAtomAction(blobsHost.setDefaults, COMMAND_OPTIONS);
  const setFlag = useAtomAction(blobsHost.setFlag, COMMAND_OPTIONS);

  const run = useCallback(
    async <A>(
      fallback: string,
      fn: (hostId: HostId) => Promise<AtomActionResult<A, unknown>>,
    ): Promise<ApiResult<A>> => {
      if (hostId === null) return NO_HOST;
      try {
        return settle(await fn(hostId), fallback);
      } catch {
        return { ok: false, message: fallback };
      }
    },
    [hostId],
  );

  return useMemo<BlobsApi>(
    () => ({
      hostId,
      create: (draft, proposalId = null) =>
        run("Could not create the blob.", (h) =>
          create({ hostId: h, input: { draft, proposalId } }),
        ),
      update: (blobId, patch) =>
        run("Could not save the blob.", (h) => update({ hostId: h, input: { blobId, patch } })),
      setSoul: (blobId, text) =>
        run("Could not save the personality.", (h) =>
          setSoul({ hostId: h, input: { blobId, text } }),
        ),
      archive: (blobId) =>
        run("Could not retire the blob.", (h) => archive({ hostId: h, input: { blobId } })),
      rehire: (blobId) =>
        run("Could not rehire the blob.", (h) => rehire({ hostId: h, input: { blobId } })),
      duplicate: (blobId) =>
        run("Could not duplicate the blob.", (h) => duplicate({ hostId: h, input: { blobId } })),
      remove: (blobId, confirmName) =>
        run("Could not delete the blob.", (h) =>
          remove({ hostId: h, input: { blobId, confirmName } }),
        ),
      get: (blobId) =>
        run("Could not load the blob.", (h) => get({ hostId: h, input: { blobId } })),
      usage: (blobId) =>
        run("Could not load usage.", (h) => usage({ hostId: h, input: { blobId } })),
      files: (blobId, since) =>
        run("Could not list files.", (h) => files({ hostId: h, input: { blobId, since } })),
      getAboutMe: async () => {
        const r = await run("Could not load About me.", (h) =>
          getAboutMe({ hostId: h, input: {} }),
        );
        return r.ok ? { ok: true, value: r.value.text } : r;
      },
      setAboutMe: async (text) => {
        const r = await run("Could not save About me.", (h) =>
          setAboutMe({ hostId: h, input: { text } }),
        );
        return r.ok ? { ok: true, value: r.value.text } : r;
      },
      getDefaults: () =>
        run("Could not load the defaults.", (h) => getDefaults({ hostId: h, input: {} })),
      setDefaults: (defaults) =>
        run("Could not save the defaults.", (h) => setDefaults({ hostId: h, input: defaults })),
      setFlag: (key, value) =>
        run("Could not save that.", (h) => setFlag({ hostId: h, input: { key, value } })),
    }),
    [
      hostId,
      run,
      create,
      update,
      setSoul,
      archive,
      rehire,
      duplicate,
      remove,
      get,
      usage,
      files,
      getAboutMe,
      setAboutMe,
      getDefaults,
      setDefaults,
      setFlag,
    ],
  );
}
