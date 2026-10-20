import type { FleetSnapshot } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergedPaneIds } from "./FleetPanel";

const snap = (workers: unknown[], events: unknown[]) =>
  ({ workers, events }) as unknown as FleetSnapshot;

describe("mergedPaneIds", () => {
  it("a worker whose branch landed stays merged after its 'merged' event scrolls out of the feed", () => {
    const s = snap([{ paneId: "p3", branchMerged: true }, { paneId: "p4" }], []);
    expect([...mergedPaneIds(s)]).toEqual(["p3"]);
  });
  it("still reads the activity feed (older runtimes without the flag)", () => {
    const s = snap(
      [{ paneId: "p5" }],
      [{ kind: "merged", workerId: "p5", text: "p5: merged into main" }],
    );
    expect([...mergedPaneIds(s)]).toEqual(["p5"]);
  });
});
