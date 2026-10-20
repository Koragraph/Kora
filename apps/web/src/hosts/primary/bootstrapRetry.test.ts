import { describe, expect, it } from "vite-plus/test";

import { retryTransientBootstrap } from "./auth";

// B6 (night 2026-10-04): a page opened while the daemon was down gave up after 15 s on "Something went wrong." and
// never recovered. An unreachable daemon is a wait: keep asking, say what we wait for, connect when it answers.
describe("retryTransientBootstrap", () => {
  it("keeps asking an unreachable daemon past the old 15 s limit, notes the wait once, and clears it on answer", async () => {
    let clock = 0;
    let calls = 0;
    const events: string[] = [];
    const value = await retryTransientBootstrap(
      async () => {
        calls += 1;
        if (calls < 40) throw new TypeError("Failed to fetch");
        return "up";
      },
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
        onWaiting: () => events.push("waiting"),
        onAnswered: () => events.push("answered"),
      },
    );
    expect(value).toBe("up");
    expect(clock).toBeGreaterThan(15_000);
    expect(events).toEqual(["waiting", "answered"]);
  });

  it("a real error (not an unreachable daemon) still fails at once", async () => {
    await expect(
      retryTransientBootstrap(
        async () => {
          throw new Error("401 bad token");
        },
        { sleep: async () => {}, onWaiting: () => {}, onAnswered: () => {} },
      ),
    ).rejects.toThrow("401 bad token");
  });
});
