// @effect-diagnostics globalDate:off nodeBuiltinImport:off globalTimers:off -- plain timestamps and a throwaway KORA_HOME.
// Plan-limit store: merge rules, the wire shape (never an `undefined` leaf), persistence and probe throttling.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { KoraUsageLimitsReport } from "./host.ts";
import { mergeUsageReport, toAgentUsageLimits, UsageLimitsService, usageProviderOf } from "./usageLimits.ts";
import { daemonConfig } from "./config.ts";

const hasUndefinedLeaf = (v: unknown): boolean =>
  v === undefined ||
  (v !== null && typeof v === "object" && Object.values(v as object).some(hasUndefinedLeaf));

const FIVE_HOUR = {
  id: "five_hour",
  kind: "session" as const,
  label: "5-hour session",
  usedPercent: 50,
  resetsAt: Date.parse("2026-10-01T23:00:00Z"),
  windowMinutes: 300,
};
const WEEKLY = {
  id: "seven_day",
  kind: "weekly" as const,
  label: "Weekly · all models",
  usedPercent: 4,
};

NodeTest.test("a complete report replaces the windows; a sparse event merges by id", () => {
  const full = mergeUsageReport(
    undefined,
    { provider: "claude", windows: [WEEKLY, FIVE_HOUR], plan: "Max", complete: true },
    1,
  );
  NodeAssert.deepEqual(
    full.windows.map((w) => w.id),
    ["seven_day", "five_hour"],
  );
  const sparse = mergeUsageReport(
    full,
    { provider: "claude", windows: [{ ...FIVE_HOUR, usedPercent: 61 }] },
    2,
  );
  NodeAssert.deepEqual(
    sparse.windows.map((w) => [w.id, w.usedPercent]),
    [
      ["seven_day", 4],
      ["five_hour", 61],
    ],
  );
  NodeAssert.equal(sparse.plan, "Max", "a sparse event keeps the plan");
  NodeAssert.equal(sparse.fullAt, 1);
});

NodeTest.test("limited until a reset, cleared once the provider serves requests again", () => {
  const limited = mergeUsageReport(
    undefined,
    { provider: "codex", windows: [], limited: true, resetsAt: 1_792_162_517_000 },
    1,
    "You’ve hit your usage limit.",
  );
  NodeAssert.deepEqual(limited.limited, {
    resetsAt: 1_792_162_517_000,
    message: "You’ve hit your usage limit.",
  });
  NodeAssert.equal(limited.unavailable, undefined);
  const stillLimited = mergeUsageReport(
    limited,
    { provider: "codex", windows: [], limited: true },
    2,
  );
  NodeAssert.equal(
    stillLimited.limited?.resetsAt,
    1_792_162_517_000,
    "a later refusal without a time keeps it",
  );
  const served = mergeUsageReport(
    stillLimited,
    { provider: "codex", windows: [{ ...FIVE_HOUR, usedPercent: 3 }] },
    3,
  );
  NodeAssert.equal(served.limited, undefined);
});

NodeTest.test(
  "an API-key account (complete, no windows) reads as unsupported, not as 'no data yet'",
  () => {
    const s = mergeUsageReport(undefined, { provider: "claude", windows: [], complete: true }, 1);
    NodeAssert.deepEqual(s.unavailable, { reason: "unsupported" });
  },
);

NodeTest.test("the wire shape: sorted session→weekly, ISO times, and no undefined leaves", () => {
  const wire = toAgentUsageLimits({
    checkedAt: Date.parse("2026-10-02T00:00:00Z"),
    windows: [WEEKLY, FIVE_HOUR],
    plan: undefined,
    limited: { resetsAt: undefined, message: undefined },
    unavailable: undefined,
  });
  NodeAssert.equal(hasUndefinedLeaf(wire), false, JSON.stringify(wire));
  NodeAssert.deepEqual(wire, {
    checkedAt: "2026-10-02T00:00:00.000Z",
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "5-hour session",
        usedPercent: 50,
        resetsAt: "2026-10-01T23:00:00.000Z",
        windowDurationMins: 300,
      },
      { id: "seven_day", kind: "weekly", label: "Weekly · all models", usedPercent: 4 },
    ],
    limited: {},
  });
});

NodeTest.test(
  "the service publishes onto the provider entry, persists, and reloads after a restart",
  async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-usage-"));
    let pushes = 0;
    const reads: string[] = [];
    const read = async (p: string): Promise<KoraUsageLimitsReport | null> => {
      reads.push(p);
      return p === "claude" ? { provider: "claude", windows: [FIVE_HOUR], plan: "Max" } : null;
    };
    const svc = new UsageLimitsService(read, () => pushes++);
    svc.init(home);
    await svc.refresh(["claude", "codex"], { force: true });
    NodeAssert.deepEqual(reads, ["claude", "codex"]);
    const claude = daemonConfig.providers.find((p) => p.instanceId === "claude")!;
    NodeAssert.equal(claude.usageLimits?.plan, "Max");
    NodeAssert.equal(claude.usageLimits?.windows[0]?.usedPercent, 50);
    const codex = daemonConfig.providers.find((p) => p.instanceId === "codex")!;
    NodeAssert.equal(codex.usageLimits?.unavailable?.reason, "probeFailed");
    // throttled: a second non-forced refresh right away does not re-probe
    await svc.refresh(["claude"]);
    NodeAssert.equal(reads.length, 2);
    await new Promise((r) => setTimeout(r, 500)); // debounced push + persist
    NodeAssert.ok(pushes >= 1);
    const again = new UsageLimitsService(
      async () => null,
      () => {},
    );
    again.init(home);
    NodeAssert.equal(
      again.snapshot("claude")?.windows[0]?.id,
      "five_hour",
      "last known numbers survive a restart",
    );
    NodeFS.rmSync(home, { recursive: true, force: true });
  },
);

NodeTest.test(
  "a checkedAt-only change persists but does not push a frame to every client",
  async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-usage-"));
    let pushes = 0;
    const svc = new UsageLimitsService(
      async () => null,
      () => pushes++,
    );
    svc.init(home);
    svc.apply("claude", { provider: "claude", windows: [FIVE_HOUR] });
    await new Promise((r) => setTimeout(r, 500));
    const after = pushes;
    svc.apply("claude", { provider: "claude", windows: [FIVE_HOUR] });
    await new Promise((r) => setTimeout(r, 500));
    NodeAssert.equal(pushes, after);
    NodeFS.rmSync(home, { recursive: true, force: true });
  },
);

NodeTest.test(
  "antigravity: probed like the others, no entry when agy is absent, last good bars kept on a failed read",
  async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-usage-"));
    let answer: KoraUsageLimitsReport | null | "absent" = {
      provider: "antigravity",
      windows: [
        { id: "gemini-weekly", kind: "weekly", label: "Gemini Models · Weekly", usedPercent: 12 },
      ],
      complete: true,
    };
    const svc = new UsageLimitsService(
      async (p) => (p === "antigravity" ? answer : null),
      () => {},
    );
    svc.init(home);
    await svc.refresh(["antigravity"], { force: true });
    NodeAssert.equal(svc.snapshot("antigravity")?.windows[0]?.usedPercent, 12);
    answer = null;
    await svc.refresh(["antigravity"], { force: true });
    const failed = svc.snapshot("antigravity");
    NodeAssert.equal(failed?.unavailable?.reason, "probeFailed");
    NodeAssert.equal(failed?.windows[0]?.usedPercent, 12, "last good bars stay");
    answer = "absent";
    await svc.refresh(["antigravity"], { force: true });
    NodeAssert.equal(svc.snapshot("antigravity"), null, "not installed = no entry");
    const entry = daemonConfig.providers.find((p) => p.instanceId === "antigravity");
    if (entry) NodeAssert.equal(entry.usageLimits, undefined);
    NodeFS.rmSync(home, { recursive: true, force: true });
  },
);

NodeTest.test(
  "opening the details (maxAgeMs) reads only providers whose numbers are older than a minute; force always reads",
  async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-usage-"));
    const first = new UsageLimitsService(
      async (p) =>
        p === "claude" ? { provider: "claude", windows: [FIVE_HOUR], plan: "Max" } : null,
      () => {},
    );
    first.init(home);
    await first.refresh(["claude"], { force: true });
    await new Promise((r) => setTimeout(r, 500)); // persisted with a fresh checkedAt
    const reads: string[] = [];
    const again = new UsageLimitsService(
      async (p) => {
        reads.push(p);
        return { provider: "claude", windows: [FIVE_HOUR] };
      },
      () => {},
    );
    again.init(home);
    await again.refresh(["claude"], { maxAgeMs: 60_000 });
    NodeAssert.deepEqual(reads, [], "fresh numbers: no CLI started");
    await again.refresh(["codex"], { maxAgeMs: 60_000 });
    NodeAssert.deepEqual(reads, ["codex"], "never read: read");
    await again.refresh(["claude"], { force: true });
    NodeAssert.deepEqual(reads, ["codex", "claude"], "the Refresh button always reads");
    NodeFS.rmSync(home, { recursive: true, force: true });
  },
);

NodeTest.test("usageProviderOf: Claude, Codex and Antigravity threads draw on a plan; OpenCode and the rest do not", () => {
  NodeAssert.equal(usageProviderOf("claude"), "claude");
  NodeAssert.equal(usageProviderOf("codex"), "codex");
  NodeAssert.equal(usageProviderOf("antigravity"), "antigravity");
  for (const d of ["opencode", "acp", "api", "", null, undefined, 7]) NodeAssert.equal(usageProviderOf(d), null);
});
