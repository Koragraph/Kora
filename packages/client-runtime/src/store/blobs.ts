import { RPC_METHODS } from "@kora/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { HostRegistry } from "../link/registry.ts";
import {
  createHostRpcCommand,
  createHostRpcQueryAtomFamily,
  createHostRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Blobs atoms (docs/bots/ARCH.md section 3): the live roster (`blobs.subscribe`, a snapshot-only stream that also
 * carries the settings flags and which engines are ready), read queries for a blob's detail / usage / files / memory,
 * and the write commands. Blob THREADS ride the normal thread atoms (a blob is a project with surface "blobs"), so
 * nothing here lists threads. Queries are family atoms keyed by their input; after a write, refetch the matching
 * query (callers know which one moved) — the roster itself updates through the subscription.
 */
export function createBlobsHostAtoms<R, E>(runtime: Atom.AtomRuntime<HostRegistry | R, E>) {
  const label = (name: string) => `environment-data:blobs:${name}`;
  return {
    /** Live `BlobsSnapshot` frames: roster (archived included), flags, engine availability, `koraReady`. */
    snapshot: createHostRpcSubscriptionAtomFamily(runtime, {
      label: label("snapshot"),
      tag: RPC_METHODS.blobsSubscribe,
      idleTtlMs: 60_000,
    }),

    /** Phase 4: one frame whenever any routine or run changes (blobId / routineId null = "something, re-read"). */
    routinesChanged: createHostRpcSubscriptionAtomFamily(runtime, {
      label: label("routines-changed"),
      tag: RPC_METHODS.blobsRoutinesSubscribe,
      idleTtlMs: 60_000,
    }),

    /** Phase 3: the whole group list, re-sent on every change (`blobs.groups.subscribe`). */
    groups: createHostRpcSubscriptionAtomFamily(runtime, {
      label: label("groups"),
      tag: RPC_METHODS.blobsGroupsSubscribe,
      idleTtlMs: 60_000,
    }),

    // ── reads ──────────────────────────────────────────────────────────────────────────────────────────────────
    list: createHostRpcQueryAtomFamily(runtime, {
      label: label("list"),
      tag: RPC_METHODS.blobsList,
      staleTimeMs: 2_000,
    }),
    /** Profile + SOUL + Core notes + skills of one blob. */
    detail: createHostRpcQueryAtomFamily(runtime, {
      label: label("detail"),
      tag: RPC_METHODS.blobsGet,
      staleTimeMs: 2_000,
    }),
    /** Tokens for one blob and per thread (the header chip). */
    usage: createHostRpcQueryAtomFamily(runtime, {
      label: label("usage"),
      tag: RPC_METHODS.blobsUsage,
      staleTimeMs: 5_000,
    }),
    /** A blob's outputs/ and files/. */
    files: createHostRpcQueryAtomFamily(runtime, {
      label: label("files"),
      tag: RPC_METHODS.blobsFiles,
      staleTimeMs: 2_000,
    }),
    memoryList: createHostRpcQueryAtomFamily(runtime, {
      label: label("memory-list"),
      tag: RPC_METHODS.blobsMemoryList,
      staleTimeMs: 2_000,
    }),
    memorySearch: createHostRpcQueryAtomFamily(runtime, {
      label: label("memory-search"),
      tag: RPC_METHODS.blobsMemorySearch,
      staleTimeMs: 10_000,
    }),
    aboutMe: createHostRpcQueryAtomFamily(runtime, {
      label: label("about-me"),
      tag: RPC_METHODS.blobsGetAboutMe,
      staleTimeMs: 2_000,
    }),
    defaults: createHostRpcQueryAtomFamily(runtime, {
      label: label("defaults"),
      tag: RPC_METHODS.blobsGetDefaults,
      staleTimeMs: 2_000,
    }),
    templates: createHostRpcQueryAtomFamily(runtime, {
      label: label("templates"),
      tag: RPC_METHODS.blobsTemplates,
      staleTimeMs: 60_000,
    }),
    job: createHostRpcQueryAtomFamily(runtime, {
      label: label("job"),
      tag: RPC_METHODS.blobsJobGet,
      staleTimeMs: 1_000,
    }),

    // ── writes ─────────────────────────────────────────────────────────────────────────────────────────────────
    create: createHostRpcCommand(runtime, { label: label("create"), tag: RPC_METHODS.blobsCreate }),
    update: createHostRpcCommand(runtime, { label: label("update"), tag: RPC_METHODS.blobsUpdate }),
    setSoul: createHostRpcCommand(runtime, {
      label: label("set-soul"),
      tag: RPC_METHODS.blobsSetSoul,
    }),
    archive: createHostRpcCommand(runtime, {
      label: label("archive"),
      tag: RPC_METHODS.blobsArchive,
    }),
    rehire: createHostRpcCommand(runtime, { label: label("rehire"), tag: RPC_METHODS.blobsRehire }),
    delete: createHostRpcCommand(runtime, { label: label("delete"), tag: RPC_METHODS.blobsDelete }),
    duplicate: createHostRpcCommand(runtime, {
      label: label("duplicate"),
      tag: RPC_METHODS.blobsDuplicate,
    }),
    setAboutMe: createHostRpcCommand(runtime, {
      label: label("set-about-me"),
      tag: RPC_METHODS.blobsSetAboutMe,
    }),
    setDefaults: createHostRpcCommand(runtime, {
      label: label("set-defaults"),
      tag: RPC_METHODS.blobsSetDefaults,
    }),
    setFlag: createHostRpcCommand(runtime, {
      label: label("set-flag"),
      tag: RPC_METHODS.blobsSetFlag,
    }),
    memoryEdit: createHostRpcCommand(runtime, {
      label: label("memory-edit"),
      tag: RPC_METHODS.blobsMemoryEdit,
    }),
    memoryForget: createHostRpcCommand(runtime, {
      label: label("memory-forget"),
      tag: RPC_METHODS.blobsMemoryForget,
    }),
    memoryImportant: createHostRpcCommand(runtime, {
      label: label("memory-important"),
      tag: RPC_METHODS.blobsMemoryImportant,
    }),
    memoryUndo: createHostRpcCommand(runtime, {
      label: label("memory-undo"),
      tag: RPC_METHODS.blobsMemoryUndo,
    }),
    memoryConfirm: createHostRpcCommand(runtime, {
      label: label("memory-confirm"),
      tag: RPC_METHODS.blobsMemoryConfirm,
    }),
    memorySetCore: createHostRpcCommand(runtime, {
      label: label("memory-set-core"),
      tag: RPC_METHODS.blobsMemorySetCore,
    }),
    hireTemplates: createHostRpcCommand(runtime, {
      label: label("hire-templates"),
      tag: RPC_METHODS.blobsHireTemplates,
    }),
    /** The job's current card, asked for on demand (a card in a transcript can be an old version): `input: { jobId }`. */
    jobGet: createHostRpcCommand(runtime, {
      label: label("job-get"),
      tag: RPC_METHODS.blobsJobGet,
    }),
    jobCancel: createHostRpcCommand(runtime, {
      label: label("job-cancel"),
      tag: RPC_METHODS.blobsJobCancel,
    }),
    jobFeedback: createHostRpcCommand(runtime, {
      label: label("job-feedback"),
      tag: RPC_METHODS.blobsJobFeedback,
    }),
    proposalDismiss: createHostRpcCommand(runtime, {
      label: label("proposal-dismiss"),
      tag: RPC_METHODS.blobsProposalDismiss,
    }),
    /** The user clicked Confirm / Not now on a `confirm` card: `input: { cardId, accept }`. */
    confirmResolve: createHostRpcCommand(runtime, {
      label: label("confirm-resolve"),
      tag: RPC_METHODS.blobsConfirmResolve,
    }),
    /** Undo a blob's self-change (SOUL / model edit) from its receipt card: `input: { token }` = the card's `undoToken`. */
    undoSelfChange: createHostRpcCommand(runtime, {
      label: label("undo-self-change"),
      tag: RPC_METHODS.blobsUndoSelfChange,
    }),
    continueOnFree: createHostRpcCommand(runtime, {
      label: label("continue-on-free"),
      tag: RPC_METHODS.blobsContinueOnFree,
    }),
  };
}
