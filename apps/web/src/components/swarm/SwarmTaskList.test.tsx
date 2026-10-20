import { SWARM_FLEET_WORKER } from "~/util/swarm.fixtures";
import { describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { HostId, ThreadId, type FleetSwarmWorker, type FleetWorker } from "@kora/contracts";

vi.mock("~/atoms/query", () => ({
  useHostQuery: (atom: unknown) => ({
    refresh: () => {},
    isPending: false,
    error: null,
    data: atom === null ? null : { text: "## Done\nValidated the form.", truncated: false },
  }),
}));
vi.mock("~/atoms/fleet", () => ({ fleetHost: { readReport: () => "report-atom" } }));
vi.mock("../ReplyMarkdown", () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("~/components/ui/tooltip", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <span>{children}</span>;
  return { Tooltip: Pass, TooltipPopup: Pass, TooltipTrigger: Pass };
});

import { deriveSwarmTask } from "./swarmTasks";

import { SwarmTaskDetail, SwarmTaskList } from "./SwarmTaskList";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const base = SWARM_FLEET_WORKER.swarm as FleetSwarmWorker;
const worker = (over: Partial<FleetSwarmWorker>, w: Partial<FleetWorker> = {}) =>
  ({ ...SWARM_FLEET_WORKER, ...w, swarm: { ...base, ...over } }) as FleetWorker;
const threadRef = { hostId: HostId.make("local"), threadId: ThreadId.make("t1") };

describe("SwarmTaskDetail", () => {
  it("a merged task shows Merged instead of the merge button", () => {
    const task = deriveSwarmTask([SWARM_FLEET_WORKER])!;
    const t = text(
      renderToStaticMarkup(
        <SwarmTaskDetail
          task={task}
          threadRef={threadRef}
          merged
          onBack={() => {}}
          onMerge={() => {}}
          onDiscard={() => {}}
          onOpenTerminal={() => {}}
        />,
      ),
    );
    expect(t).toContain("Merged");
    expect(t).not.toContain("Merge anyway");
  });
  it("shows the result to review and the actions the daemon supports", () => {
    const task = deriveSwarmTask([
      { ...SWARM_FLEET_WORKER, tokens: { input: 1200, cached: 5000, output: 300 } } as FleetWorker,
    ])!;
    const t = text(
      renderToStaticMarkup(
        <SwarmTaskDetail
          task={task}
          threadRef={threadRef}
          merged={false}
          onBack={() => {}}
          onMerge={() => {}}
          onDiscard={() => {}}
          onOpenTerminal={() => {}}
        />,
      ),
    );
    expect(t).toContain("Validated the form.");
    expect(t).toContain("opencode-3");
    expect(t).toContain("merge gate clean after 1 bounce");
    expect(t).toContain("qwen3-coder:free rate-limited → big-pickle finished");
    expect(t).toContain("1,500 in+out · 5,000 cache reads (measured by OpenCode)");
    for (const label of ["Terminal", "Stop worker", "Merge"]) expect(t).toContain(label);
    expect(t).not.toContain("$");
  });
});

describe("SwarmTaskList", () => {
  it("says when a task needs you", () => {
    const failed = deriveSwarmTask([
      worker({ phase: "failed", verify: null }, { state: "exited", exitCode: 2 }),
    ])!;
    const t = text(
      renderToStaticMarkup(
        <SwarmTaskList tasks={[failed]} activity={null} merged={new Set()} onOpen={() => {}} />,
      ),
    );
    expect(t).toContain("1 task needs you");
    expect(t).toContain("OpenCode stopped (exit code 2)");
  });
  it("one row per task: title, state, model, attempt, one activity line; the meter on top", () => {
    const passed = deriveSwarmTask([SWARM_FLEET_WORKER])!;
    const limited = deriveSwarmTask([
      worker({ taskId: "s4", phase: "rate-limited", verify: null, report: null, attempt: 1 }),
    ])!;
    const t = text(
      renderToStaticMarkup(
        <SwarmTaskList
          tasks={[passed, limited]}
          activity={null}
          merged={new Set()}
          onOpen={() => {}}
        />,
      ),
    );
    expect(t).toContain("workers did 0 tasks");
    expect(t).toContain("Add input validation to the signup form");
    expect(t).toContain("Passed");
    expect(t).toContain("zen · big-pickle · attempt 2");
    expect(t).toContain("Cooling down");
    expect(t).toContain("big-pickle is rate-limited");
  });
});
