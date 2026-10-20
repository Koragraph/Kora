import { HostId, type ThreadIndexSnapshot } from "@kora/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsHostKey,
  parseArchivedThreadsHostKey,
} from "./archivedThreads.ts";

it("round-trips environment keys in sorted order", () => {
  const envA = HostId.make("env-a");
  const envB = HostId.make("env-b");
  const key = makeArchivedThreadsHostKey([envB, envA]);

  expect(parseArchivedThreadsHostKey(key)).toEqual([envA, envB]);
});

it("does not expose an archived snapshot failure message", () => {
  const failed = AsyncResult.failure<ThreadIndexSnapshot, Error>(
    Cause.fail(new Error("credential=secret-value")),
  );
  const family = createArchivedThreadSnapshotsAtomFamily<Error>({
    labelPrefix: "test:archived-thread-snapshots",
    getSnapshotAtom: () => Atom.make(failed),
  });
  const registry = AtomRegistry.make();
  const key = makeArchivedThreadsHostKey([HostId.make("env-sensitive")]);
  try {
    // Only the generic copy reaches the UI.
    expect(registry.get(family(key))).toEqual({
      isLoading: false,
      error: "Failed to load archived threads.",
      snapshots: [],
    });
  } finally {
    registry.dispose();
  }
});
