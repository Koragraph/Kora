import { describe, expect, it } from "vite-plus/test";

import { resolveThreadDot, type ThreadDot, type ThreadDotTone } from "../../ThreadNav.logic";
import { countWorkingBlobs, deriveBlobStatus, shouldWarnConcurrency } from "./blobStatus";

// Build a real dot for a tone through the same resolver the sidebar uses, via the offline escape hatch where the
// tone is not derivable from a minimal shell.
const dot = (tone: ThreadDotTone): ThreadDot => {
  if (tone === "offline") return resolveThreadDot({} as never, undefined, true);
  const labels: Record<string, string> = {
    approval: "Needs your approval",
    input: "Waiting for your answer",
    plan: "Plan ready for your review",
    failed: "Last turn failed",
    working: "Working",
    unread: "Finished — not opened yet",
    monitoring: "Monitoring",
    idle: "Finished — seen",
  };
  return { tone, label: labels[tone]!, dotClass: "", pulse: tone === "working" };
};

describe("deriveBlobStatus", () => {
  it("no threads = idle", () => {
    expect(deriveBlobStatus([])).toMatchObject({ word: "idle", visual: "idle", unread: false });
  });
  it("working", () => {
    const s = deriveBlobStatus([dot("idle"), dot("working")]);
    expect(s).toMatchObject({ word: "working", visual: "working", working: true });
  });
  it("an approval beats a running thread (needs you first)", () => {
    const s = deriveBlobStatus([dot("working"), dot("approval")]);
    expect(s).toMatchObject({
      word: "needs you",
      visual: "waiting",
      needsYou: true,
      working: true,
    });
  });
  it("a question reads 'asking'", () => {
    expect(deriveBlobStatus([dot("input")])).toMatchObject({ word: "asking", visual: "waiting" });
  });
  it("a failed turn is an error", () => {
    expect(deriveBlobStatus([dot("failed")])).toMatchObject({ word: "error", visual: "failed" });
  });
  it("a daemon that is down is paused/offline and beats everything", () => {
    expect(deriveBlobStatus([dot("approval"), dot("offline")])).toMatchObject({
      word: "paused",
      visual: "offline",
    });
  });
  it("an unread reply stays idle but raises the unread flag", () => {
    expect(deriveBlobStatus([dot("unread"), dot("idle")])).toMatchObject({
      word: "idle",
      unread: true,
      needsYou: false,
    });
  });
});

describe("concurrency warning", () => {
  it("counts working blobs", () => {
    expect(
      countWorkingBlobs([
        deriveBlobStatus([dot("working")]),
        deriveBlobStatus([dot("idle")]),
        deriveBlobStatus([dot("working")]),
      ]),
    ).toBe(2);
  });
  it("warns on the 3rd blob, not the 2nd, not for one already working, not once dismissed", () => {
    const two = new Set(["a", "b"]);
    expect(
      shouldWarnConcurrency({ workingBlobIds: two, startingBlobId: "c", dismissed: false }),
    ).toBe(true);
    expect(
      shouldWarnConcurrency({
        workingBlobIds: new Set(["a"]),
        startingBlobId: "b",
        dismissed: false,
      }),
    ).toBe(false);
    expect(
      shouldWarnConcurrency({ workingBlobIds: two, startingBlobId: "a", dismissed: false }),
    ).toBe(false);
    expect(
      shouldWarnConcurrency({ workingBlobIds: two, startingBlobId: "c", dismissed: true }),
    ).toBe(false);
  });
});

describe("recovered failures (live QA #2: a red dot beside 'working')", () => {
  it("an old failed thread stops counting once a newer one is working or finished; a newer question / approval outranks it anyway", () => {
    for (const tone of ["working", "input", "approval", "idle", "unread"] as const) {
      const s = deriveBlobStatus([dot(tone), dot("failed")]);
      expect(s.word, tone).not.toBe("error");
    }
    expect(deriveBlobStatus([dot("failed"), dot("idle")]).word).toBe("error");
    // an offline daemon is not a recovery
    expect(deriveBlobStatus([dot("offline"), dot("failed")]).word).toBe("paused");
  });
  it("the sidebar's own dot uses the same rule", async () => {
    const { withoutRecoveredFailures } = await import("./blobStatus");
    const { rollupThreadDots } = await import("../../ThreadNav.logic");
    const dots = [dot("working"), dot("failed"), dot("failed")];
    expect(withoutRecoveredFailures(dots).map((d) => d.tone)).toEqual(["working"]);
    // the roster row used to roll up ALL the dots: a red dot beside "working" (failed outranks working)
    expect(rollupThreadDots(dots)?.tone).toBe("failed");
    expect(rollupThreadDots(withoutRecoveredFailures(dots))?.tone).toBe("working");
    expect(rollupThreadDots(withoutRecoveredFailures([dot("failed"), dot("idle")]))?.tone).toBe(
      "failed",
    );
  });
});
