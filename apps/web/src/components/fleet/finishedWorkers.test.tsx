import type { FleetWorker } from "@kora/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { FinishedWorkersRow } from "./FinishedWorkersRow";
import { finishedMarker, finishedTone, splitFinishedWorkers } from "./finishedWorkers";

const worker = (over: Partial<FleetWorker>): FleetWorker =>
  ({
    paneId: "p1",
    terminalId: "worker:p1",
    agent: "claude",
    account: null,
    title: "Add retry",
    state: "exited",
    blocker: null,
    steered: false,
    steeredAt: null,
    cwd: "/x",
    worktree: null,
    costUsd: null,
    contextPct: null,
    exitCode: 0,
    createdAt: 0,
    lastOutputAt: 0,
    ...over,
  }) as FleetWorker;

describe("finished workers", () => {
  it("only exited workers become markers; live ones keep their tile", () => {
    const live = worker({ paneId: "p2", state: "working" });
    const done = worker({ paneId: "p3" });
    const { active, finished } = splitFinishedWorkers([live, done]);
    expect(active.map((w) => w.paneId)).toEqual(["p2"]);
    expect(finished.map((w) => w.paneId)).toEqual(["p3"]);
  });

  it("tone and result: done, failed, stopped", () => {
    expect(finishedTone(worker({}))).toBe("done");
    expect(finishedTone(worker({ exitCode: 2 }))).toBe("failed");
    expect(finishedTone(worker({ exitCode: 143, stoppedByUser: true }))).toBe("stopped");
    expect(finishedMarker(worker({ exitCode: 2 }), false).result).toBe("Failed (exit 2)");
    expect(finishedMarker(worker({}), true).result).toBe("Done, merged");
    expect(finishedMarker(worker({ stoppedByUser: true }), false).result).toBe("Stopped by you");
    expect(finishedMarker(worker({ title: "  " }), false).title).toBe("claude");
  });

  it("the row renders one reopen button per marker and nothing when empty", () => {
    const markers = [
      finishedMarker(worker({}), false),
      finishedMarker(worker({ paneId: "p9", exitCode: 1 }), false),
    ];
    const html = renderToStaticMarkup(
      <FinishedWorkersRow markers={markers} onOpen={() => undefined} />,
    );
    expect(html).toContain('data-finished-workers="2"');
    expect(html).toContain('data-finished-pane="p9"');
    expect(html).toContain('data-tone="failed"');
    expect(renderToStaticMarkup(<FinishedWorkersRow markers={[]} onOpen={() => undefined} />)).toBe(
      "",
    );
  });
});
