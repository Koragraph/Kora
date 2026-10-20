// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Tests early boot persistence outside Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  CRASH_LOOP_WINDOW_MS,
  clearLaunchRecord,
  filterRecentTimestamps,
  readLaunchTimestamps,
  recordLaunchAttempt,
  shouldTriggerCrashLoop,
} from "./CrashLoopGuard.ts";

describe("CrashLoopGuard", () => {
  it("filters out timestamps older than the window", () => {
    const now = 1000_000;
    const timestamps = [
      now - CRASH_LOOP_WINDOW_MS - 5000, // expired
      now - 60_000, // within 2 min
      now - 10_000, // within 2 min
    ];

    const recent = filterRecentTimestamps(timestamps, now);
    expect(recent).toEqual([now - 60_000, now - 10_000]);
  });

  it("triggers crash loop only when recent failed launches >= threshold (2)", () => {
    expect(shouldTriggerCrashLoop([])).toBe(false);
    expect(shouldTriggerCrashLoop([1000])).toBe(false);
    expect(shouldTriggerCrashLoop([1000, 2000])).toBe(true);
    expect(shouldTriggerCrashLoop([1000, 2000, 3000])).toBe(true);
  });

  it("reads and persists launch timestamps", async () => {
    const tmpDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "crash-guard-test-"));
    const filePath = NodePath.join(tmpDir, "launch-record.json");

    try {
      // Missing file returns empty array
      const empty = await readLaunchTimestamps(filePath);
      expect(empty).toEqual([]);

      // Record first launch
      const t1 = 500_000;
      await recordLaunchAttempt(filePath, t1);
      const afterFirst = await readLaunchTimestamps(filePath);
      expect(afterFirst).toEqual([t1]);

      // Record second launch within window
      const t2 = t1 + 30_000;
      await recordLaunchAttempt(filePath, t2);
      const afterSecond = await readLaunchTimestamps(filePath);
      expect(afterSecond).toEqual([t1, t2]);

      // Clear removes record
      await clearLaunchRecord(filePath);
      const afterClear = await readLaunchTimestamps(filePath);
      expect(afterClear).toEqual([]);
    } finally {
      await NodeFSP.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
