import { ThreadId, TurnId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { PlanProposal } from "../../types";
import { deriveActivePlanState, findLatestPlanProposal, hasActionableProposedPlan } from "./plans";
import { activity, at } from "./testActivities";

type Step = { step: string; status: string };
/** A to-do list update in turn `turn`, `seconds` in. */
const update = (
  seconds: number,
  steps: Step[],
  extra: { turn?: string; sequence?: number; explanation?: string } = {},
) =>
  activity("turn.plan.updated", {
    time: seconds,
    turn: extra.turn ?? "t1",
    tone: "info",
    summary: "Plan updated",
    ...(extra.sequence === undefined ? {} : { sequence: extra.sequence }),
    payload: {
      plan: steps,
      ...(extra.explanation === undefined ? {} : { explanation: extra.explanation }),
    },
  });
const steps = (...pairs: Array<[string, string]>) =>
  pairs.map(([step, status]) => ({ step, status }));
const t1 = TurnId.make("t1");

describe("the to-do list shown above the composer", () => {
  it("is the latest update of the current turn, explanation included", () => {
    const plan = deriveActivePlanState(
      [
        update(1, steps(["Read the code", "pending"]), { explanation: "first idea" }),
        update(2, steps(["Fix the parser", "inProgress"]), { explanation: "better idea" }),
      ],
      t1,
    );
    expect(plan).toEqual({
      createdAt: at(2),
      turnId: "t1",
      explanation: "better idea",
      steps: [{ step: "Fix the parser", status: "inProgress" }],
    });
  });

  it("carries over from an earlier turn when this one has none", () => {
    expect(
      deriveActivePlanState([update(1, steps(["Write tests", "completed"]))], TurnId.make("t2")),
    ).toEqual({
      createdAt: at(1),
      turnId: "t1",
      steps: [{ step: "Write tests", status: "completed" }],
    });
  });

  it("is gone once an update empties it", () => {
    expect(
      deriveActivePlanState([update(1, steps(["Look", "inProgress"])), update(2, [])], t1),
    ).toBeNull();
  });

  it("is null when there is no plan at all", () => {
    expect(deriveActivePlanState([activity("tool.completed")], undefined)).toBeNull();
  });
});

describe("how long each finished step took", () => {
  it("a step never seen in progress runs from the previous finish (or the plan's start)", () => {
    const plan = deriveActivePlanState(
      [
        update(0, steps(["A", "pending"], ["B", "pending"])),
        update(4, steps(["A", "pending"], ["B", "completed"])),
        update(10, steps(["A", "completed"], ["B", "completed"])),
      ],
      t1,
    );
    expect(plan?.steps).toEqual([
      { step: "A", status: "completed", durationMs: 6_000 },
      { step: "B", status: "completed", durationMs: 4_000 },
    ]);
  });

  it("two steps with the same text are timed separately", () => {
    const plan = deriveActivePlanState(
      [
        update(0, steps(["Check", "inProgress"], ["Check", "pending"])),
        update(3, steps(["Check", "completed"], ["Check", "inProgress"])),
        update(10, steps(["Check", "completed"], ["Check", "completed"])),
      ],
      t1,
    );
    expect(plan?.steps.map((s) => s.durationMs)).toEqual([3_000, 7_000]);
  });

  it("restart from zero after the plan was cleared and written again", () => {
    const plan = deriveActivePlanState(
      [
        update(0, steps(["Check", "inProgress"])),
        update(4, steps(["Check", "completed"])),
        update(5, []),
        update(20, steps(["Check", "inProgress"])),
        update(22, steps(["Check", "completed"])),
      ],
      t1,
    );
    expect(plan?.steps).toEqual([{ step: "Check", status: "completed", durationMs: 2_000 }]);
  });

  it("follow the daemon's sequence numbers, not the input order, and ignore other activities", () => {
    const input = Object.freeze([
      update(5, steps(["Check", "completed"]), { sequence: 3 }),
      activity("tool.completed", { sequence: 4 }),
      update(0, steps(["Check", "inProgress"]), { sequence: 1 }),
      activity("context-window.updated", { sequence: 2 }),
    ]);
    expect(deriveActivePlanState(input, t1)?.steps).toEqual([
      { step: "Check", status: "completed", durationMs: 5_000 },
    ]);
  });
});

describe("the proposed plan", () => {
  const proposal = (
    id: string,
    turn: string,
    updated: number,
    markdown: string,
    done = false,
  ): PlanProposal => ({
    id,
    turnId: TurnId.make(turn),
    planMarkdown: markdown,
    createdAt: at(0),
    updatedAt: at(updated),
    implementedAt: done ? at(updated) : null,
    implementationThreadId: done ? ThreadId.make("impl") : null,
  });

  it("is the current turn's most recently updated one", () => {
    const latest = findLatestPlanProposal(
      [
        proposal("p2", "t2", 9, "# other turn"),
        proposal("p1", "t1", 5, "# newest"),
        proposal("p1", "t1", 2, "# older"),
      ],
      TurnId.make("t1"),
    );
    expect(latest).toEqual({
      id: "p1",
      turnId: "t1",
      planMarkdown: "# newest",
      createdAt: at(0),
      updatedAt: at(5),
      implementedAt: null,
      implementationThreadId: null,
    });
  });

  it("is the thread's most recently updated one when no turn is given", () => {
    const latest = findLatestPlanProposal(
      [proposal("p1", "t1", 1, "# first"), proposal("p2", "t2", 3, "# last")],
      null,
    );
    expect(latest?.planMarkdown).toBe("# last");
  });

  it("can be acted on only until it has been carried out", () => {
    expect(hasActionableProposedPlan(proposal("p", "t1", 1, "#"))).toBe(true);
    expect(hasActionableProposedPlan(proposal("p", "t1", 1, "#", true))).toBe(false);
    expect(hasActionableProposedPlan(null)).toBe(false);
  });
});
