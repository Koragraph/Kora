import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  BLOB_METHODS,
  BlobCardPayload,
  BlobProfile,
  BlobsStreamEvent,
  CHIEF_BLOB_ID,
  MemoryReceipt,
} from "./blobs.ts";
import { ChatThreadHead, ProjectSurface, ThreadOrigin } from "./chat.ts";
import { KoraRpcGroup, RPC_METHODS } from "./koraRpc.ts";

const strict = { onExcessProperty: "error" } as const;

const profile = {
  id: CHIEF_BLOB_ID,
  version: 1,
  name: "Kora",
  title: "Chief",
  role: "chief",
  teamId: "default",
  engine: { instanceId: "claude", model: "sonnet", effort: null },
  permission: "auto",
  outfit: { head: "crown", face: null, neck: "bow-tie" },
  toolGrants: {
    apps: { mode: "none", allow: [] },
    mcp: [],
    computer: { browser: false, vm: false },
  },
  slug: "kora",
  workspace: "/Users/x/Blobs/kora",
  templateId: null,
  pinned: true,
  hidden: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 2,
} as const;

it.effect("a BlobProfile round-trips strictly and the stream snapshot decodes", () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(BlobProfile)(profile, strict);
    assert.deepStrictEqual<unknown>(yield* Schema.encodeEffect(BlobProfile)(decoded), profile);
    const event = yield* Schema.decodeUnknownEffect(BlobsStreamEvent)(
      {
        type: "snapshot",
        snapshot: {
          seq: 1,
          blobs: [profile],
          flags: {
            concurrencyWarningDismissed: false,
            galleryDismissed: false,
            claudeMemoryFallback: false,
          },
          engines: {
            best: { instanceId: "claude", model: "sonnet", effort: null },
            claude: { ready: true },
            codex: { ready: false },
            opencode: { ready: true, freeModels: 3 },
          },
          koraReady: true,
          memoryModel: null,
        },
      },
      strict,
    );
    assert.strictEqual(event.snapshot.blobs[0]?.role, "chief");
  }),
);

it.effect("card payloads discriminate on cardKind", () =>
  Effect.gen(function* () {
    const receipt = {
      id: "r1",
      kind: "added",
      scope: "you",
      text: "Lives in Dallas",
      previousText: null,
      factId: "f1",
      undone: false,
      reason: null,
    };
    yield* Schema.decodeUnknownEffect(MemoryReceipt)(receipt, strict);
    const card = yield* Schema.decodeUnknownEffect(BlobCardPayload)(
      { cardKind: "memory", cardId: "c1", version: 1, receipts: [receipt] },
      strict,
    );
    assert.strictEqual(card.cardKind, "memory");
    const bad = yield* Effect.flip(
      Schema.decodeUnknownEffect(BlobCardPayload)({ cardKind: "nope", cardId: "c" }),
    );
    assert.ok(bad);
  }),
);

it.effect("projects may carry the blobs surface and threads an origin", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* Schema.decodeUnknownEffect(ProjectSurface)("blobs"), "blobs");
    const origin = yield* Schema.decodeUnknownEffect(ThreadOrigin)(
      { kind: "kora", jobId: "j", stepId: "s", fromThreadId: null, fromBlobId: CHIEF_BLOB_ID },
      strict,
    );
    assert.strictEqual(origin.kind, "kora");
    assert.ok("origin" in ChatThreadHead.fields);
  }),
);

it.effect(
  "the confirm card decodes key-for-key what the runtime builds, and rejects a state it does not know",
  () =>
    Effect.gen(function* () {
      const confirm = {
        cardKind: "confirm",
        cardId: "conf_1",
        version: 2,
        action: "edit",
        blobId: "blob_x",
        blobName: "Popo",
        summary: "Update Popo",
        details: ["Title: A -> B"],
        state: "confirmed",
        result: "Popo updated.",
      };
      const card = yield* Schema.decodeUnknownEffect(BlobCardPayload)(confirm, strict);
      assert.strictEqual(card.cardKind, "confirm");
      yield* Schema.decodeUnknownEffect(BlobCardPayload)(
        { ...confirm, blobId: null, blobName: null, result: null, state: "open" },
        strict,
      );
      const bad = yield* Effect.flip(
        Schema.decodeUnknownEffect(BlobCardPayload)({ ...confirm, state: "pending" }),
      );
      assert.ok(bad);
      assert.strictEqual(RPC_METHODS.blobsConfirmResolve, BLOB_METHODS.confirmResolve);
      assert.ok(KoraRpcGroup.requests.has("blobs.confirm.resolve"));
    }),
);

it("every BLOB_METHODS name is a distinct RPC in KoraRpcGroup", () => {
  const names = Object.values(BLOB_METHODS);
  assert.strictEqual(new Set(names).size, names.length);
  for (const name of names) assert.ok(KoraRpcGroup.requests.has(name), `${name} is in the group`);
  assert.strictEqual(RPC_METHODS.blobsSubscribe, BLOB_METHODS.subscribe);
  assert.strictEqual(RPC_METHODS.blobsContinueOnFree, BLOB_METHODS.continueOnFree);
  assert.strictEqual(RPC_METHODS.blobsUndoSelfChange, BLOB_METHODS.undoSelfChange);
});
