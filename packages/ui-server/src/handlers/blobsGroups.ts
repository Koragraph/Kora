// @effect-diagnostics globalDate:off -- plain wall-clock reads at the boundary to the in-process group runtime.
import type {
  GroupCreateInput,
  GroupDeleteInput,
  GroupIdInput,
  GroupUpdateInput,
  GroupsStreamEvent,
  TeamExportInput,
  TeamImportApplyInput,
  TeamImportPlanInput,
  TeamPreviewInput,
} from "@kora/contracts";
import { CHIEF_BLOB_ID, GROUP_METHODS } from "@kora/contracts";

import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { readBlobDefaults } from "../blobsFs.ts";
import { resolveEngine } from "../blobsEngine.ts";
import { host, type KoraGroupJson, type KoraGroupsLike, type KoraTeamFileLike } from "../host.ts";
import { chatEngine } from "../kora-chat.ts";
import { type HandlerRecord, jsonSafe } from "./shared.ts";
import { callAsync, fail, notifyBlobsChanged, runtimeFor } from "./blobs.ts";

/**
 * `blobs.groups.*` and `blobs.team.*` (docs/bots/GROUPS.md): thin delegation to the runtime's `GroupsService` and
 * `TeamFileService`. Wire rules as blobs.ts: results go through `jsonSafe`, failures are typed `BlobError`s. Two things are
 * enforced HERE because they are about what crosses the wire:
 *   - an import is a PLAN held by the daemon: the client only names which parts to skip, it never sends content back;
 *   - the engine a new blob gets is resolved here (the runtime cannot see which engines are installed).
 */

const message = (cause: unknown): string => String((cause as Error)?.message ?? cause);

function groupsOf(operation: string): KoraGroupsLike {
  const g = runtimeFor(operation).groups;
  if (!g)
    throw fail(
      operation,
      "Group chats are not available in this daemon yet. Restart Kora to finish updating it.",
      "unavailable",
    );
  return g;
}

function teamfileOf(operation: string): KoraTeamFileLike {
  const t = runtimeFor(operation).teamfile;
  if (!t)
    throw fail(
      operation,
      "Team files are not available in this daemon yet. Restart Kora to finish updating it.",
      "unavailable",
    );
  return t;
}

/** Groups are plain JSON already; this pins the exact wire fields (no stray runtime state leaves the daemon). */
function groupWire(g: KoraGroupJson) {
  return {
    id: g.id,
    name: g.name,
    slug: g.slug,
    memberIds: [...g.memberIds],
    leadId: g.leadId,
    rule: g.rule,
    instructions: g.instructions,
    workspace: g.workspace,
    pinned: g.pinned,
    archivedAt: g.archivedAt ?? null,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

let snapshotSeq = 0;
function groupsSnapshot(): GroupsStreamEvent {
  const svc = host().blobs?.groups;
  let list: KoraGroupJson[] = [];
  try {
    list = svc ? svc.groups.list({ includeArchived: true }) : [];
  } catch (cause) {
    host().log(`[kora-ui] groups snapshot: list failed (${message(cause)})`);
  }
  snapshotSeq += 1;
  return { type: "snapshot", seq: snapshotSeq, groups: list.map(groupWire) };
}

/** Whole-list stream: seeded on subscribe, re-sent on every change to a group (a member retiring prunes groups too). */
const groupsStream = (): Stream.Stream<GroupsStreamEvent> =>
  Stream.callback<GroupsStreamEvent>((queue) =>
    Effect.gen(function* () {
      const push = () => Queue.offerUnsafe(queue, jsonSafe(groupsSnapshot()));
      let off: () => void = () => {};
      try {
        const svc = host().blobs?.groups;
        if (svc) {
          svc.on("changed", push);
          off = () => {
            try {
              svc.off("changed", push);
            } catch {
              /* already gone */
            }
          };
        }
      } catch (cause) {
        host().log(`[kora-ui] groups.subscribe: unavailable (${message(cause)})`);
      }
      yield* Effect.addFinalizer(() => Effect.sync(off));
      push();
      return yield* Effect.never;
    }),
  );

function wrapGroupError(operation: string, cause: unknown): never {
  const code = (cause as { code?: unknown } | null)?.code;
  throw fail(operation, message(cause), typeof code === "string" ? code : null);
}

const afterGroupWrite = (): void => {
  chatEngine().syncGroupProjects();
  notifyBlobsChanged();
};

export const blobsGroupsHandlers: HandlerRecord = {
  [GROUP_METHODS.subscribe]: () => groupsStream(),

  [GROUP_METHODS.create]: (input) => {
    const i = input as GroupCreateInput;
    return callAsync("groupsCreate", async () => {
      const svc = groupsOf("groupsCreate");
      try {
        const g = svc.groups.create({
          name: i.name,
          memberIds: [...i.memberIds],
          ...(i.leadId ? { leadId: i.leadId } : {}),
          ...(i.rule ? { rule: i.rule } : {}),
          ...(i.instructions !== undefined ? { instructions: i.instructions } : {}),
        });
        afterGroupWrite();
        return groupWire(g);
      } catch (cause) {
        return wrapGroupError("groupsCreate", cause);
      }
    });
  },

  [GROUP_METHODS.update]: (input) => {
    const i = input as GroupUpdateInput;
    return callAsync("groupsUpdate", async () => {
      const svc = groupsOf("groupsUpdate");
      try {
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(i.patch))
          if (v !== undefined) patch[k] = Array.isArray(v) ? [...v] : v;
        const g = svc.groups.update(i.id, patch);
        afterGroupWrite();
        return groupWire(g);
      } catch (cause) {
        return wrapGroupError("groupsUpdate", cause);
      }
    });
  },

  [GROUP_METHODS.archive]: (input) => {
    const i = input as GroupIdInput;
    return callAsync("groupsArchive", async () => {
      const svc = groupsOf("groupsArchive");
      try {
        const g = svc.groups.archive(i.id);
        afterGroupWrite();
        return groupWire(g);
      } catch (cause) {
        return wrapGroupError("groupsArchive", cause);
      }
    });
  },

  [GROUP_METHODS.delete]: (input) => {
    const i = input as GroupDeleteInput;
    return callAsync("groupsDelete", async () => {
      const svc = groupsOf("groupsDelete");
      try {
        svc.groups.delete(i.id, i.confirmName);
      } catch (cause) {
        return wrapGroupError("groupsDelete", cause);
      }
      // the group's threads (and its members' hidden sessions) go with it
      afterGroupWrite();
      return {};
    });
  },

  [GROUP_METHODS.teamOptions]: () =>
    callAsync("teamOptions", async () => {
      const t = teamfileOf("teamOptions");
      const blobs = runtimeFor("teamOptions");
      const kora = blobs.store.get(CHIEF_BLOB_ID);
      return { koraId: kora && kora.archivedAt == null ? CHIEF_BLOB_ID : null, ...t.options() };
    }),

  [GROUP_METHODS.teamPreview]: (input) => {
    const i = input as TeamPreviewInput;
    return callAsync("teamPreview", async () => teamfileOf("teamPreview").preview(i.selection));
  },

  [GROUP_METHODS.teamExport]: (input) => {
    const i = input as TeamExportInput;
    return callAsync("teamExport", async () => teamfileOf("teamExport").export(i.selection));
  },

  [GROUP_METHODS.teamImportPlan]: (input) => {
    const i = input as TeamImportPlanInput;
    return callAsync("teamImportPlan", async () => {
      const t = teamfileOf("teamImportPlan");
      const url = typeof i.url === "string" ? i.url.trim() : "";
      const text = typeof i.text === "string" ? i.text : "";
      if (!url && !text.trim())
        throw fail(
          "teamImportPlan",
          "Choose a team file, paste its text or paste an https link.",
          "invalid",
        );
      const r = url ? await t.planFromUrl(url) : t.planFromText(text);
      if (!r.ok) throw fail("teamImportPlan", r.error, "invalid");
      return r.plan;
    });
  },

  [GROUP_METHODS.teamImportApply]: (input) => {
    const i = input as TeamImportApplyInput;
    return callAsync("teamImportApply", async () => {
      const t = teamfileOf("teamImportApply");
      const blobs = runtimeFor("teamImportApply");
      const defaults = blobs.store.defaults?.() ?? readBlobDefaults();
      const engine = await resolveEngine(null, defaults.engine);
      if (!engine)
        throw fail(
          "teamImportApply",
          "No engine is ready. Sign in to Claude or Codex, or finish the free-model setup, then import again.",
          "no_engine",
        );
      let result;
      try {
        result = t.apply(
          i.planId,
          {
            blobs: [...i.skip.blobs],
            groups: [...i.skip.groups],
            replace: [...(i.skip.replace ?? [])],
          },
          engine,
        );
      } catch (cause) {
        return wrapGroupError("teamImportApply", cause);
      }
      chatEngine().syncBlobProjects();
      afterGroupWrite();
      return result;
    });
  },
};
