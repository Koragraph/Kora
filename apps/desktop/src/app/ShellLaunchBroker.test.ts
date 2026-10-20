import { ProjectId, ThreadId, type ShellLaunchRequest } from "@kora/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ShellLaunchBroker } from "./ShellLaunchBroker.ts";

const open = (requestId: string): ShellLaunchRequest => ({
  version: 1,
  requestId,
  type: "open-workspace",
  workspaceRoot: "/Users/sam/code/acme",
  platform: "darwin",
});

const done = (requestId: string) => ({
  version: 1 as const,
  requestId,
  ok: true as const,
  projectId: ProjectId.make("p-acme"),
  threadId: ThreadId.make("t-1"),
});

/** A broker plus its activation spy; closed after each test. */
let broker: ShellLaunchBroker | null = null;
function makeBroker(timeoutMs = 2_000) {
  const activate = vi.fn();
  broker = new ShellLaunchBroker({ requestTimeoutMs: timeoutMs, activate });
  return { broker, activate };
}
afterEach(() => {
  broker?.close();
  broker = null;
  vi.useRealTimers();
});

describe("a `kora open` request from the CLI", () => {
  it("brings the app forward at once, but reaches the window only once it is ready", async () => {
    const { broker, activate } = makeBroker();
    const deliver = vi.fn();
    const reply = broker.request(open("r1"));
    expect([activate.mock.calls.length, deliver.mock.calls.length]).toEqual([1, 0]);
    broker.registerRenderer(deliver);
    expect(deliver.mock.calls).toEqual([[open("r1")]]);
    broker.complete(done("r1"));
    expect(await reply).toMatchObject({ ok: true, projectId: "p-acme", threadId: "t-1" });
  });

  it("waits for the next window when the previous one went away first", async () => {
    const { broker } = makeBroker();
    const old = vi.fn();
    const fresh = vi.fn();
    broker.registerRenderer(old);
    broker.clearRenderer();
    const reply = broker.request(open("r2"));
    expect(old).not.toHaveBeenCalled();
    broker.registerRenderer(fresh);
    expect(fresh).toHaveBeenCalledWith(open("r2"));
    broker.complete(done("r2"));
    expect(await reply).toMatchObject({ ok: true });
  });

  it("goes one at a time; a queued request the CLI gave up on is never delivered", async () => {
    const { broker } = makeBroker();
    const deliver = vi.fn();
    broker.registerRenderer(deliver);
    const first = broker.request(open("a"));
    const second = broker.request(open("b"));
    expect(deliver.mock.calls.map(([r]) => r.requestId)).toEqual(["a"]);
    broker.cancel("b");
    broker.complete(done("a"));
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: false });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe("requests that cannot finish", () => {
  it("the window closing mid-request answers renderer-unavailable", async () => {
    const { broker } = makeBroker();
    broker.registerRenderer(vi.fn());
    const reply = broker.request(open("r3"));
    broker.clearRenderer();
    expect(await reply).toMatchObject({ ok: false, code: "renderer-unavailable" });
  });

  it("a request cancelled while queued is answered, and the next window never sees it", async () => {
    const { broker } = makeBroker();
    const deliver = vi.fn();
    const reply = broker.request(open("r4"));
    broker.cancel("r4");
    broker.registerRenderer(deliver);
    expect(await reply).toMatchObject({ ok: false, code: "renderer-unavailable" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("times out on a timer, not by polling", async () => {
    vi.useFakeTimers();
    const { broker } = makeBroker(750);
    const reply = broker.request(open("r5"));
    await vi.advanceTimersByTimeAsync(750);
    expect(await reply).toMatchObject({ ok: false, code: "request-timeout" });
  });
});
