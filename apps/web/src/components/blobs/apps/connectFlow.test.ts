import { describe, expect, it } from "vite-plus/test";

import {
  UNAVAILABLE_APPS_API,
  type AppAccountWire,
  type AppsApi,
  type AppsResult,
} from "./appsApi";
import { runConnect, type ConnectPhase } from "./connectFlow";

const acct = (id: string, alias: string | null, status = "ACTIVE"): AppAccountWire => ({
  id,
  toolkit: "gmail",
  alias,
  status,
});
const ok = <T>(value: T): AppsResult<T> => ({ ok: true, value });

function rig(o: {
  accounts: Array<AppAccountWire[]>;
  link?: AppsResult<{ url: string; expiresAt: number }>;
}) {
  const phases: ConnectPhase[] = [];
  const opened: string[] = [];
  let i = 0;
  let now = 1_000_000;
  const api: AppsApi = {
    ...UNAVAILABLE_APPS_API,
    accounts: async () => ok(o.accounts[Math.min(i++, o.accounts.length - 1)]!),
    connect: async () =>
      o.link ?? ok({ url: "https://connect.composio.dev/l/1", expiresAt: now + 600_000 }),
  };
  const deps = {
    api,
    open: (u: string) => {
      opened.push(u);
    },
    onPhase: (p: ConnectPhase) => phases.push(p),
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    pollMs: 2000,
  };
  return { deps, phases, opened };
}

describe("runConnect", () => {
  it("opens the link, polls, and finishes on the first NEW active account", async () => {
    const r = rig({
      accounts: [
        [acct("a1", null)],
        [acct("a1", null)],
        [acct("a1", null), acct("a2", "Work", "INITIATED")],
        [acct("a1", null), acct("a2", "Work")],
      ],
    });
    const final = await runConnect("gmail", "Work", r.deps);
    expect(final).toMatchObject({ phase: "connected", account: { id: "a2", alias: "Work" } });
    expect(r.opened).toEqual(["https://connect.composio.dev/l/1"]);
    expect(r.phases.map((p) => p.phase)).toEqual(["starting", "waiting", "connected"]);
  });

  it("an account that was already there does not count as the new one", async () => {
    const r = rig({ accounts: [[acct("a1", null)], [acct("a1", null)]] });
    const final = await runConnect("gmail", null, { ...r.deps, timeoutMs: 6000 });
    expect(final).toMatchObject({ phase: "error", code: "link_expired" });
  });

  it("an expired link is refused before anything opens; a broker error carries its code", async () => {
    const stale = rig({ accounts: [[]], link: ok({ url: "https://x", expiresAt: 5 }) });
    expect(await runConnect("gmail", null, stale.deps)).toMatchObject({
      phase: "error",
      code: "link_expired",
    });
    expect(stale.opened).toEqual([]);
    const capped = rig({
      accounts: [[]],
      link: { ok: false, message: "5 of 5", code: "account_limit" },
    });
    expect(await runConnect("gmail", "x", capped.deps)).toMatchObject({
      phase: "error",
      code: "account_limit",
      message: "5 of 5",
    });
  });

  it("a browser that cannot open the link does not stop the flow (the visible link is the fallback)", async () => {
    const r = rig({ accounts: [[], [acct("a1", null)]] });
    const final = await runConnect("gmail", null, {
      ...r.deps,
      open: () => {
        throw new Error("no browser");
      },
    });
    expect(final.phase).toBe("connected");
  });

  it("cancelling stops the poll quietly", async () => {
    const r = rig({ accounts: [[], []] });
    let n = 0;
    const final = await runConnect("gmail", null, { ...r.deps, cancelled: () => ++n > 2 });
    expect(final.phase).toBe("idle");
  });
});
