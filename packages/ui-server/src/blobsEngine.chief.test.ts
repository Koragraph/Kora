// @effect-diagnostics nodeBuiltinImport:off -- a throwaway KORA_HOME for the migration's marker file.
// The Chief's engine `default` (= Opus on most logins) moves once to the model new blobs get (pl2 S2-4).
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { CHIEF_BLOB_ID, type BlobProfile } from "@kora/contracts";

import { migrateChiefDefaultModel } from "./blobsEngine.ts";

function fakeStore(engine: BlobProfile["engine"]) {
  let chief = { id: CHIEF_BLOB_ID, engine } as unknown as BlobProfile;
  const updates: unknown[] = [];
  return {
    updates,
    get: (id: string) => (id === CHIEF_BLOB_ID ? chief : null),
    update: (id: string, patch: Partial<BlobProfile>) => {
      updates.push({ id, patch });
      chief = { ...chief, ...patch } as BlobProfile;
      return chief;
    },
    chief: () => chief,
  };
}

NodeTest.test(
  "a Chief on Claude `default` moves to Sonnet once; a later Default pick is kept",
  async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-chief-model-"));
    const store = fakeStore({ instanceId: "claude", model: "default", effort: null });
    NodeAssert.equal(await migrateChiefDefaultModel(store as never, home, () => "sonnet"), true);
    NodeAssert.equal(store.chief().engine.model, "sonnet");
    // The user picks Default again on purpose: the marker keeps the migration from undoing it.
    store.update(CHIEF_BLOB_ID, {
      engine: { instanceId: "claude", model: "default", effort: null },
    });
    NodeAssert.equal(await migrateChiefDefaultModel(store as never, home, () => "sonnet"), false);
    NodeAssert.equal(store.chief().engine.model, "default");
  },
);

NodeTest.test("a Chief on another model or engine is left alone", async () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-chief-model-"));
  const store = fakeStore({ instanceId: "codex", model: "default", effort: null });
  NodeAssert.equal(await migrateChiefDefaultModel(store as never, home, () => "sonnet"), false);
  NodeAssert.equal(store.updates.length, 0);
});
