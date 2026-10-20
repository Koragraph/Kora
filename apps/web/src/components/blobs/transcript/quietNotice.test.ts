import { describe, expect, it } from "vite-plus/test";

import { quietNoticeLabel } from "./quietNotice";

describe("quietNoticeLabel", () => {
  it("never leaks the [kora] prompt, 'Worker updates' or the agent names", () => {
    const worker =
      '[kora] worker p2 ("Read the pricing pages") has EXITED with code 0. Check its worktree / output and continue the plan.';
    const job =
      '[kora] Junip finished "Wedding toast" (job job_c35, step s1). Read the result against your brief with wait_for, then accept_step.';
    const other = "[kora] the user pinned this thread";
    expect(quietNoticeLabel(worker, "Popo")).toBe("Popo got an update from a helper");
    expect(quietNoticeLabel(job, "Kora")).toBe("Update on a task Kora handed out");
    expect(quietNoticeLabel(other, "Popo")).toBe("A note from Kora");
    for (const t of [worker, job, other])
      expect(quietNoticeLabel(t, "Popo")).not.toMatch(/\[kora\]|worker updates|claude|swarm/i);
  });
});
