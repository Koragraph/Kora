// @effect-diagnostics globalDate:off -- plain wall-clock reads at the boundary to the in-process blob runtime.
// @effect-diagnostics nodeBuiltinImport:off -- plain fs path joins onto a blob's workspace.
import type {
  BlobsStreamEvent,
  BlobsSnapshot,
  BlobUpdateInput,
  BlobUndoSelfChangeInput,
  BlobSetTextInput,
  BlobProposalDismissInput,
  BlobProfile,
  BlobMemoryUndoInput,
  BlobMemorySetCoreInput,
  BlobMemorySearchInput,
  BlobMemoryListInput,
  BlobMemoryImportantInput,
  BlobMemoryFactInput,
  BlobMemoryEditInput,
  BlobMemoryConfirmInput,
  BlobJobGetInput,
  BlobJobFeedbackInput,
  BlobConfirmResolveInput,
  BlobJobCancelInput,
  BlobIdInput,
  BlobHireTemplatesInput,
  BlobFlagInput,
  BlobFilesInput,
  BlobDetail,
  BlobFlags,
  BlobDeleteInput,
  BlobDefaults,
  BlobCreateInput,
  BlobContinueOnFreeInput,
  BlobAboutMe,
} from "@kora/contracts";
import { BLOB_METHODS, BlobError, CHIEF_BLOB_ID } from "@kora/contracts";
import * as fs from "node:fs";

import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Effect from "effect/Effect";

import {
  resolveEngine,
  onStoreChanged,
  memoryModel,
  swarmStatusOrNull,
  engineAvailability,
  applyOpencodeFreeModels,
} from "../blobsEngine.ts";
import {
  writeBlobFlag,
  writeBlobDefaults,
  writeAboutMe,
  readBlobFlags,
  readBlobDefaults,
  readAboutMe,
  moveToTrash,
  listBlobFiles,
  DEFAULT_SOUL_TEMPLATE,
  ABOUT_ME_MAX_CHARS,
} from "../blobsFs.ts";
import * as mem from "../blobsMemory.ts";
import { isBlobsCwd } from "../assistantFs.ts";
import { host, type KoraBlobsLike } from "../host.ts";
import { chatEngine } from "../kora-chat.ts";
import { onAgentsChanged } from "../modelRefresh.ts";
import { koraSurfaceOn } from "../koraSurface.ts";
import { type HandlerRecord, jsonSafe } from "./shared.ts";

/**
 * `blobs.*` handlers (docs/bots/ARCH.md section 3): thin delegation to the runtime's `BlobRuntime` (`UiHost.blobs`),
 * plus the pieces that live ui-side — the blob <-> project mirror, about-me / defaults / flags files, per-blob usage and
 * the engine availability. Like chatSurface.ts: every unary result and every stream frame goes through `jsonSafe`
 * (a nested undefined tears the socket) and every failure is a typed `BlobError` — never a hang or a defect.
 */

const message = (cause: unknown): string => String((cause as Error)?.message ?? cause);

export function fail(operation: string, msg: string, code: string | null = null): BlobError {
  return new BlobError({ operation, message: msg, code });
}

const isBlobError = Schema.is(BlobError);

function toBlobError(operation: string, cause: unknown): BlobError {
  if (isBlobError(cause)) return cause;
  const code = (cause as { code?: unknown } | null)?.code;
  return fail(operation, message(cause), typeof code === "string" ? code : null);
}

const call = <A>(operation: string, run: () => A) =>
  Effect.try({
    try: () => jsonSafe(run()),
    catch: (cause) => toBlobError(operation, cause),
  });

export const callAsync = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => toBlobError(operation, cause) }).pipe(
    Effect.map((value) => jsonSafe(value)),
  );

/** The runtime's blob runtime, or a typed "unavailable" (an older daemon has none). */
export function runtimeFor(operation: string): KoraBlobsLike {
  const blobs = host().blobs;
  if (!blobs)
    throw fail(
      operation,
      "Blobs are not available in this daemon yet. Restart Kora to finish updating it.",
      "unavailable",
    );
  return blobs;
}

/** Every non-deleted blob, retired ones included (the store's default list hides them). */
function allBlobs(blobs: KoraBlobsLike): BlobProfile[] {
  return blobs.store.list({ includeArchived: true });
}

export function profileOf(blobs: KoraBlobsLike, operation: string, blobId: string): BlobProfile {
  const profile = blobs.store.get(blobId);
  if (!profile) throw fail(operation, `There is no blob ${blobId}.`, "not_found");
  return profile;
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Names are unique among non-archived blobs, case-insensitively (delegation and @mentions route by name). */
function assertNameFree(
  blobs: KoraBlobsLike,
  operation: string,
  name: string,
  exceptId: string | null,
): void {
  const key = nameKey(name);
  if (!key) throw fail(operation, "A blob needs a name.", "name_required");
  const clash = allBlobs(blobs).find(
    (b) => b.archivedAt == null && b.id !== exceptId && nameKey(b.name) === key,
  );
  if (clash)
    throw fail(
      operation,
      `There is already a blob called ${clash.name}. Pick another name.`,
      "name_taken",
    );
}

const ENGINES = new Set(["claude", "codex", "opencode"]);
function assertEngine(operation: string, instanceId: string): void {
  if (ENGINES.has(instanceId)) return;
  // Phase 7: `claude-<account>` (a named Claude login) and any ACP agent / API endpoint the user set up in Settings > Engines.
  if (/^claude-[a-z0-9][a-z0-9-]{0,29}$/.test(instanceId)) return;
  try {
    if (host().engines?.route(instanceId)) return;
  } catch {
    /* no engines service: only the built-ins */
  }
  throw fail(operation, `Unknown engine ${instanceId}.`, "unknown_engine");
}

// ── change fan-out to blobs.subscribe ───────────────────────────────────────────────────────────────────────────
const changeListeners = new Set<() => void>();
/** Something a snapshot shows changed (flags, defaults, a write through these handlers). */
export function notifyBlobsChanged(): void {
  for (const fn of changeListeners) {
    try {
      fn();
    } catch {
      /* a listener must never break a write */
    }
  }
}

let snapshotSeq = 0;
async function buildBlobsSnapshot(): Promise<BlobsSnapshot> {
  // Kora is coming soon (koraSurface.ts): an empty roster that says so. No store read, no routing prewarm (the warm
  // Haiku session), no swarm / engine probes, no extractor status.
  if (!koraSurfaceOn()) {
    snapshotSeq += 1;
    return jsonSafe({
      seq: snapshotSeq,
      blobs: [],
      flags: flagsNow(),
      engines: {
        best: null,
        claude: { ready: false },
        codex: { ready: false },
        opencode: { ready: false, freeModels: 0 },
      },
      koraReady: false,
      memoryModel: null,
      koraSurface: "coming-soon" as const,
    });
  }
  const blobs = host().blobs;
  let list: BlobProfile[] = [];
  try {
    list = blobs ? allBlobs(blobs) : [];
  } catch (cause) {
    host().log(`[kora-ui] blobs snapshot: store.list failed (${message(cause)})`);
  }
  let koraReady = list.some((b) => b.id === CHIEF_BLOB_ID && b.archivedAt == null);
  try {
    const reported = blobs?.koraReady?.();
    if (typeof reported === "boolean") koraReady = reported;
  } catch {
    /* keep the derived value */
  }
  snapshotSeq += 1;
  // Surface load / group open: start the routing model's session now, not on the first message (a no-op while it runs).
  try {
    blobs?.prewarmRouting?.();
  } catch {
    /* advisory */
  }
  // One swarm-status read feeds both fields (it used to be read twice, one after the other, on every cold load).
  const swarm = await swarmStatusOrNull();
  const [engines, memoryModelName] = await Promise.all([
    engineAvailability(swarm),
    memoryModel(flagsNow().claudeMemoryFallback, swarm),
  ]);
  let claudeCallsToday: number | undefined;
  try {
    const n = (blobs?.extractorStatus?.() as { claudeCallsToday?: unknown } | null | undefined)
      ?.claudeCallsToday;
    if (typeof n === "number" && Number.isFinite(n)) claudeCallsToday = n;
  } catch {
    /* advisory */
  }
  return jsonSafe({
    seq: snapshotSeq,
    blobs: list,
    flags: flagsNow(),
    engines,
    koraReady,
    memoryModel: memoryModelName,
    ...(claudeCallsToday !== undefined ? { claudeCallsToday } : {}),
    koraSurface: "on" as const,
  });
}

/** Snapshot-only stream: seed with the current snapshot, then every profile / flag / engine change. Held open. */
const blobsStream = (): Stream.Stream<BlobsStreamEvent> =>
  Stream.callback<BlobsStreamEvent>((queue) =>
    Effect.gen(function* () {
      let latest = 0;
      const push = () => {
        const mine = ++latest;
        void buildBlobsSnapshot().then(
          (snapshot) => {
            // A newer rebuild is already in flight: this one is stale.
            if (mine === latest)
              Queue.offerUnsafe(queue, jsonSafe({ type: "snapshot", snapshot } as const));
          },
          (cause: unknown) =>
            host().log(`[kora-ui] blobs.subscribe: snapshot failed (${message(cause)})`),
        );
      };
      const offs: Array<() => void> = [];
      const hook = (subscribe: () => () => void, what: string) => {
        try {
          offs.push(subscribe());
        } catch (cause) {
          host().log(`[kora-ui] blobs.subscribe: ${what} unavailable (${message(cause)})`);
        }
      };
      hook(() => {
        const store = host().blobs?.store;
        return store ? onStoreChanged(store, push) : () => {};
      }, "store events");
      hook(
        () =>
          host().swarm.onStatus((status) => {
            applyOpencodeFreeModels(status);
            push();
          }),
        "swarm status",
      );
      hook(() => onAgentsChanged(() => push()), "agent changes");
      changeListeners.add(push);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          changeListeners.delete(push);
          for (const off of offs) {
            try {
              off();
            } catch {
              /* already gone */
            }
          }
        }),
      );
      push();
      return yield* Effect.never;
    }),
  );

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function detailOf(
  blobs: KoraBlobsLike,
  operation: string,
  blobId: string,
): Promise<BlobDetail> {
  const profile = profileOf(blobs, operation, blobId);
  let core = { you: "", blob: "" };
  try {
    const c = await blobs.memory.getCore(blobId);
    core = { you: c.you, blob: c.blob };
  } catch (cause) {
    host().log(`[kora-ui] blobs.get: core notes unreadable for ${blobId} (${message(cause)})`);
  }
  let skills: BlobDetail["skills"] = [];
  try {
    skills = blobs.store.skills?.(blobId) ?? [];
  } catch {
    /* no skills listing */
  }
  return { profile, soul: blobs.store.soul(blobId), core, skills };
}

// The workspace-wide files: the runtime store owns them when it offers the methods (open sessions then go stale on
// their own); otherwise the ui-server reads and writes the same files.
const storeOf = () => host().blobs?.store;
const aboutMeNow = (): string => storeOf()?.aboutMe?.() ?? readAboutMe();
const defaultsNow = (): BlobDefaults => storeOf()?.defaults?.() ?? readBlobDefaults();
const flagsNow = (): BlobFlags => storeOf()?.flags?.() ?? readBlobFlags();

/** After any store write: re-sync the project mirror and tell subscribers (the store may or may not emit "changed"). */
function afterWrite(profile?: BlobProfile): void {
  if (profile) chatEngine().upsertBlobProject(profile);
  else chatEngine().syncBlobProjects();
  notifyBlobsChanged();
}

const unavailableAsync = (operation: string, what: string) =>
  Effect.fail(fail(operation, `${what} is not available yet.`, "unavailable"));

export const blobsHandlers: HandlerRecord = {
  [BLOB_METHODS.subscribe]: () => blobsStream(),

  [BLOB_METHODS.list]: () => callAsync("list", () => buildBlobsSnapshot()),

  [BLOB_METHODS.get]: (input) => {
    const i = input as BlobIdInput;
    return callAsync("get", async () => detailOf(runtimeFor("get"), "get", i.blobId));
  },

  [BLOB_METHODS.create]: (input) => {
    const i = input as BlobCreateInput;
    return callAsync("create", async () => {
      const blobs = runtimeFor("create");
      const draft = i.draft;
      assertNameFree(blobs, "create", draft.name, null);
      const defaults = defaultsNow();
      const engine = await resolveEngine(draft.engine, defaults.engine);
      if (!engine)
        throw fail(
          "create",
          "No engine is ready. Sign in to Claude or Codex, or finish the free-model setup, then hire again.",
          "no_engine",
        );
      assertEngine("create", engine.instanceId);
      // Phase 2: the team hires it (a proposal card flips to hired, Kora hears about it, routines are written paused).
      // The engine is resolved here ("best installed" needs the swarm status the runtime does not see).
      if (blobs.hireDraft) {
        const profile = await blobs.hireDraft({ ...draft, engine }, i.proposalId);
        afterWrite(profile);
        return profile;
      }
      const profile = await blobs.store.create({
        name: draft.name.trim(),
        title: draft.title.trim(),
        soul: draft.soul.trim() || defaults.soulTemplate.trim() || DEFAULT_SOUL_TEMPLATE,
        engine,
        permission: draft.permission,
        outfit: draft.outfit,
        templateId: draft.templateId,
      });
      afterWrite(profile);
      if (i.proposalId) {
        try {
          await blobs.proposalHired?.(i.proposalId, profile.id);
        } catch (cause) {
          host().log(
            `[kora-ui] blobs.create: proposal ${i.proposalId} not marked hired (${message(cause)})`,
          );
        }
      }
      return profile;
    });
  },

  [BLOB_METHODS.update]: (input) => {
    const i = input as BlobUpdateInput;
    return callAsync("update", async () => {
      const blobs = runtimeFor("update");
      const current = profileOf(blobs, "update", i.blobId);
      if (i.patch.name !== undefined && nameKey(i.patch.name) !== nameKey(current.name))
        assertNameFree(blobs, "update", i.patch.name, current.id);
      if (i.patch.engine) assertEngine("update", i.patch.engine.instanceId);
      const profile = await blobs.store.update(i.blobId, i.patch);
      afterWrite(profile);
      return profile;
    });
  },

  [BLOB_METHODS.setSoul]: (input) => {
    const i = input as BlobSetTextInput;
    return callAsync("setSoul", async () => {
      const blobs = runtimeFor("setSoul");
      profileOf(blobs, "setSoul", i.blobId);
      await blobs.store.writeSoul(i.blobId, i.text);
      notifyBlobsChanged();
      return detailOf(blobs, "setSoul", i.blobId);
    });
  },

  [BLOB_METHODS.archive]: (input) => {
    const i = input as BlobIdInput;
    return callAsync("archive", async () => {
      const blobs = runtimeFor("archive");
      const current = profileOf(blobs, "archive", i.blobId);
      if (current.role === "chief" || current.id === CHIEF_BLOB_ID)
        throw fail("archive", "Kora is the Chief and can't be retired.", "chief_protected");
      const profile = await blobs.store.archive(i.blobId);
      afterWrite(profile);
      return profile;
    });
  },

  [BLOB_METHODS.rehire]: (input) => {
    const i = input as BlobIdInput;
    return callAsync("rehire", async () => {
      const blobs = runtimeFor("rehire");
      const current = profileOf(blobs, "rehire", i.blobId);
      // A retired blob's name may have been taken since.
      assertNameFree(blobs, "rehire", current.name, current.id);
      const profile = await blobs.store.rehire(i.blobId);
      afterWrite(profile);
      return profile;
    });
  },

  [BLOB_METHODS.delete]: (input) => {
    const i = input as BlobDeleteInput;
    return callAsync("delete", async () => {
      const blobs = runtimeFor("delete");
      const current = profileOf(blobs, "delete", i.blobId);
      if (current.role === "chief" || current.id === CHIEF_BLOB_ID)
        throw fail("delete", "Kora is the Chief and can't be deleted.", "chief_protected");
      if (i.confirmName.trim() !== current.name)
        throw fail("delete", `Type ${current.name} to confirm the delete.`, "confirm_mismatch");
      if (!isBlobsCwd(current.workspace))
        throw fail(
          "delete",
          `${current.workspace} is outside the Blobs folder, so Kora won't move it. Remove the blob's folder yourself, then delete the blob.`,
          "outside_blobs_root",
        );
      // Its browser holds files open in the blob's home (profile, cookies): close it gracefully before anything moves.
      await blobs.browserLive?.close(current.id).catch(() => undefined);
      // Folder first: a refused move (another disk) must leave the blob exactly as it was.
      const trashed = moveToTrash(current.workspace);
      try {
        await blobs.store.delete(current.id, current.name);
      } catch (cause) {
        // Nothing else is gone yet: put the folder back where it was.
        if (trashed) {
          try {
            fs.renameSync(trashed, current.workspace);
          } catch {
            /* the Trash copy stays; the error below still tells the user */
          }
        }
        throw cause;
      }
      chatEngine().deleteBlobProject(current.id);
      try {
        await blobs.memory.forgetBlob(current.id);
      } catch (cause) {
        host().log(
          `[kora-ui] blobs.delete: memory for ${current.id} not cleared (${message(cause)})`,
        );
      }
      notifyBlobsChanged();
      return {};
    });
  },

  [BLOB_METHODS.duplicate]: (input) => {
    const i = input as BlobIdInput;
    return callAsync("duplicate", async () => {
      const blobs = runtimeFor("duplicate");
      const source = profileOf(blobs, "duplicate", i.blobId);
      if (source.role === "chief")
        throw fail("duplicate", "There is only one Kora.", "chief_protected");
      let name = `${source.name} copy`;
      for (
        let n = 2;
        allBlobs(blobs).some((b) => b.archivedAt == null && nameKey(b.name) === nameKey(name));
        n++
      )
        name = `${source.name} copy ${n}`;
      const profile = await blobs.store.create({
        name,
        title: source.title,
        soul: blobs.store.soul(source.id),
        engine: source.engine,
        permission: source.permission,
        outfit: source.outfit,
        templateId: source.templateId,
        toolGrants: source.toolGrants,
        teamId: source.teamId,
      });
      afterWrite(profile);
      return profile;
    });
  },

  [BLOB_METHODS.getAboutMe]: () => call("getAboutMe", () => ({ text: aboutMeNow() })),

  [BLOB_METHODS.setAboutMe]: (input) => {
    const i = input as BlobAboutMe;
    return call("setAboutMe", () => {
      if (i.text.length > ABOUT_ME_MAX_CHARS)
        throw fail(
          "setAboutMe",
          `About me is ${i.text.length.toLocaleString("en-US")} characters; the limit is ${ABOUT_ME_MAX_CHARS.toLocaleString("en-US")}.`,
          "too_large",
        );
      const store = storeOf();
      const text = store?.setAboutMe ? store.setAboutMe(i.text) : writeAboutMe(i.text);
      host().blobs?.refresh?.();
      return { text };
    });
  },

  [BLOB_METHODS.getDefaults]: () => call("getDefaults", () => defaultsNow()),

  [BLOB_METHODS.setDefaults]: (input) => {
    const i = input as BlobDefaults;
    return call("setDefaults", () => {
      if (i.engine) assertEngine("setDefaults", i.engine.instanceId);
      const store = storeOf();
      const saved = store?.setDefaults ? store.setDefaults(i) : writeBlobDefaults(i);
      host().blobs?.refresh?.();
      return saved;
    });
  },

  [BLOB_METHODS.setFlag]: (input) => {
    const i = input as BlobFlagInput;
    return call("setFlag", () => {
      const store = storeOf();
      const flags = store?.setFlag ? store.setFlag(i.key, i.value) : writeBlobFlag(i.key, i.value);
      notifyBlobsChanged();
      return flags;
    });
  },

  [BLOB_METHODS.usage]: (input) => {
    const i = input as BlobIdInput;
    return call("usage", () => {
      profileOf(runtimeFor("usage"), "usage", i.blobId);
      return chatEngine().blobUsage(i.blobId);
    });
  },

  [BLOB_METHODS.files]: (input) => {
    const i = input as BlobFilesInput;
    return call("files", () => {
      const profile = profileOf(runtimeFor("files"), "files", i.blobId);
      return { files: listBlobFiles(profile.workspace, i.since) };
    });
  },

  [BLOB_METHODS.memoryList]: (input) => {
    const i = input as BlobMemoryListInput;
    return callAsync("memoryList", async () => mem.listMemory(runtimeFor("memoryList").memory, i));
  },

  [BLOB_METHODS.memoryEdit]: (input) => {
    const i = input as BlobMemoryEditInput;
    return callAsync("memoryEdit", async () =>
      mem.editFact(runtimeFor("memoryEdit").memory, i.factId, i.text),
    );
  },

  [BLOB_METHODS.memoryForget]: (input) => {
    const i = input as BlobMemoryFactInput;
    return callAsync("memoryForget", async () =>
      mem.forgetFact(runtimeFor("memoryForget").memory, i.factId),
    );
  },

  [BLOB_METHODS.memoryImportant]: (input) => {
    const i = input as BlobMemoryImportantInput;
    return callAsync("memoryImportant", async () =>
      mem.markImportant(runtimeFor("memoryImportant").memory, i.factId, i.important),
    );
  },

  [BLOB_METHODS.memoryUndo]: (input) => {
    const i = input as BlobMemoryUndoInput;
    return callAsync("memoryUndo", async () => {
      const receipt = await mem.undoReceipt(
        runtimeFor("memoryUndo").memory,
        i.receiptId,
        chatEngine().findMemoryReceipt(i.receiptId),
      );
      chatEngine().reemitMemoryReceipt(receipt);
      return receipt;
    });
  },

  [BLOB_METHODS.memoryConfirm]: (input) => {
    const i = input as BlobMemoryConfirmInput;
    return callAsync("memoryConfirm", async () => {
      const receipt = await mem.confirmReceipt(
        runtimeFor("memoryConfirm").memory,
        i.receiptId,
        i.save,
        chatEngine().findMemoryReceipt(i.receiptId),
      );
      chatEngine().reemitMemoryReceipt(receipt, i.receiptId);
      return receipt;
    });
  },

  [BLOB_METHODS.memorySetCore]: (input) => {
    const i = input as BlobMemorySetCoreInput;
    return callAsync("memorySetCore", async () => {
      const blobs = runtimeFor("memorySetCore");
      const core = await mem.setCore(blobs.memory, i);
      blobs.refresh?.();
      return { core };
    });
  },

  [BLOB_METHODS.memorySearch]: (input) => {
    const i = input as BlobMemorySearchInput;
    return callAsync("memorySearch", async () => {
      const limit = Math.max(1, Math.min(20, Math.trunc(i.limit) || 5));
      return {
        episodes: await mem.searchEpisodes(runtimeFor("memorySearch").memory, {
          blobId: i.blobId,
          query: i.query,
          limit,
        }),
      };
    });
  },

  [BLOB_METHODS.templates]: () =>
    call("templates", () => ({ templates: host().blobs?.templates?.() ?? [] })),

  [BLOB_METHODS.hireTemplates]: (input) => {
    const i = input as BlobHireTemplatesInput;
    const blobs = host().blobs;
    if (!blobs?.hireTemplates) return unavailableAsync("hireTemplates", "Hiring from the roster");
    return callAsync("hireTemplates", async () => {
      const profiles = await blobs.hireTemplates!(i.templateIds);
      afterWrite();
      return { profiles };
    });
  },

  [BLOB_METHODS.jobGet]: (input) => {
    const i = input as BlobJobGetInput;
    const blobs = host().blobs;
    if (!blobs?.jobGet) return unavailableAsync("jobGet", "Jobs");
    return callAsync("jobGet", async () => blobs.jobGet!(i.jobId));
  },

  [BLOB_METHODS.jobCancel]: (input) => {
    const i = input as BlobJobCancelInput;
    const blobs = host().blobs;
    if (!blobs?.jobCancel) return unavailableAsync("jobCancel", "Jobs");
    return callAsync("jobCancel", async () => blobs.jobCancel!(i.jobId, i.stepId));
  },

  [BLOB_METHODS.jobFeedback]: (input) => {
    const i = input as BlobJobFeedbackInput;
    const blobs = host().blobs;
    if (!blobs?.jobFeedback) return unavailableAsync("jobFeedback", "Jobs");
    return callAsync("jobFeedback", async () => {
      await blobs.jobFeedback!(i.jobId, i.stepId, i.reaction);
      return {};
    });
  },

  [BLOB_METHODS.proposalDismiss]: (input) => {
    const i = input as BlobProposalDismissInput;
    const blobs = host().blobs;
    if (!blobs?.proposalDismiss) return unavailableAsync("proposalDismiss", "Proposals");
    return callAsync("proposalDismiss", async () => {
      await blobs.proposalDismiss!(i.proposalId);
      return {};
    });
  },

  [BLOB_METHODS.confirmResolve]: (input) => {
    const i = input as BlobConfirmResolveInput;
    const blobs = host().blobs;
    if (!blobs?.confirmResolve) return unavailableAsync("confirmResolve", "Confirmations");
    return callAsync("confirmResolve", async () => {
      const r = await blobs.confirmResolve!(i.cardId, i.accept);
      // The click may have hired / edited / retired blobs: re-sync the project mirror and the roster.
      afterWrite();
      return r;
    });
  },

  [BLOB_METHODS.undoSelfChange]: (input) => {
    const i = input as BlobUndoSelfChangeInput;
    return callAsync("undoSelfChange", async () => {
      const blobs = runtimeFor("undoSelfChange");
      if (!blobs.undoSelfChange)
        throw fail("undoSelfChange", "Undo is not available yet.", "unavailable");
      if (!(await blobs.undoSelfChange(i.token)))
        throw fail(
          "undoSelfChange",
          "That change can't be undone any more (it was already undone, or it is too old).",
          "not_undoable",
        );
      chatEngine().markSelfChangeUndone(i.token);
      notifyBlobsChanged();
      return { undone: true };
    });
  },

  [BLOB_METHODS.continueOnFree]: (input) => {
    const i = input as BlobContinueOnFreeInput;
    return callAsync("continueOnFree", async () => ({
      threadId: await chatEngine().continueBlobThreadOnFree(i.threadId),
    }));
  },
};
