import type { FleetWorker } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { SWARM_FLEET_WORKER } from "~/util/swarm.fixtures";

import { appendWorkerReference, workerDragPayload, workerReferenceText } from "./blobReference";

const WORKER: FleetWorker = {
  ...SWARM_FLEET_WORKER,
  paneId: "p3",
  title: "IMDb sitcoms",
} as FleetWorker;

describe("workerReferenceText", () => {
  it("formats as @worker <paneId> (<title>) — the spec's fallback form", () => {
    expect(workerReferenceText(WORKER)).toBe("@worker p3 (IMDb sitcoms)");
  });
});

describe("workerDragPayload", () => {
  it("carries the given drag type and the reference text", () => {
    expect(workerDragPayload(WORKER, "application/x-kora-composer-mention")).toEqual({
      type: "application/x-kora-composer-mention",
      text: "@worker p3 (IMDb sitcoms)",
    });
  });
});

describe("appendWorkerReference", () => {
  it("appends to an empty prompt with no leading space", () => {
    expect(appendWorkerReference("", WORKER)).toBe("@worker p3 (IMDb sitcoms) ");
  });

  it("adds a boundary space when the prompt doesn't end in whitespace", () => {
    expect(appendWorkerReference("check this out", WORKER)).toBe(
      "check this out @worker p3 (IMDb sitcoms) ",
    );
  });

  it("does not add an extra space when the prompt already ends in whitespace", () => {
    expect(appendWorkerReference("check this out ", WORKER)).toBe(
      "check this out @worker p3 (IMDb sitcoms) ",
    );
  });

  it("is idempotent: referencing the same worker twice only inserts once", () => {
    const once = appendWorkerReference("", WORKER);
    expect(appendWorkerReference(once, WORKER)).toBe(once);
  });
});
