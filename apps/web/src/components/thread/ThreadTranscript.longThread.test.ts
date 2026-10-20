// Long-thread render-cost guard. A power user's thread easily reaches hundreds of turns with
// thousands of tool calls; every streamed token re-runs this projection, so it has to stay
// linear and the streaming path has to reuse (not rebuild) the rows of settled history.
import { describe, expect, it } from "vite-plus/test";
import { ItemId, TurnId } from "@kora/contracts";

import {
  computeStableTranscriptRows,
  deriveTranscriptRows,
  deriveTranscriptRowsWithState,
} from "./ThreadTranscript.logic";
import { deriveTranscriptEntriesWithState, type WorkLogEntry } from "../../thread/timeline";
import type { ChatMessage } from "../../types";

const TOOLS_PER_TURN = 6;

function syntheticThread(turns: number) {
  const time = (ms: number) => new Date(Date.UTC(2026, 8, 1) + ms).toISOString();
  const messages: ChatMessage[] = [];
  const work: WorkLogEntry[] = [];
  let clock = 0;
  for (let turn = 0; turn < turns; turn += 1) {
    const turnId = TurnId.make(`turn-${turn}`);
    const last = turn === turns - 1;
    messages.push({
      id: ItemId.make(`user-${turn}`),
      role: "user",
      text: `Please change module ${turn}`,
      turnId: null,
      createdAt: time((clock += 1000)),
      updatedAt: time(clock),
      streaming: false,
    });
    for (let tool = 0; tool < TOOLS_PER_TURN; tool += 1) {
      work.push({
        id: `work-${turn}-${tool}`,
        turnId,
        createdAt: time((clock += 1000)),
        label: tool % 2 === 0 ? "Read file" : "Ran command",
        tone: "tool",
        ...(tool % 2 === 0
          ? { changedFiles: [`/repo/src/module-${turn}/file-${tool}.ts`] }
          : { command: `vp test run src/module-${turn}` }),
        toolCallId: `tool-${turn}-${tool}`,
        toolLifecycleStatus: last ? "inProgress" : tool === 3 ? "failed" : "completed",
        sourceActivityKind: last ? "tool.started" : "tool.completed",
      });
    }
    messages.push({
      id: ItemId.make(`assistant-${turn}`),
      role: "assistant",
      text: last
        ? ""
        : `Done with module ${turn}.\n\n\`\`\`ts\nexport const x${turn} = ${turn};\n\`\`\``,
      turnId,
      createdAt: time((clock += 1000)),
      updatedAt: time(clock),
      streaming: last,
    });
  }
  const lastTurnId = TurnId.make(`turn-${turns - 1}`);
  const timeline = deriveTranscriptEntriesWithState(messages, [], work);
  const input = {
    timelineEntries: timeline.entries,
    latestTurn: {
      turnId: lastTurnId,
      state: "running" as const,
      startedAt: time(clock - 7000),
      completedAt: null,
    },
    runningTurnId: lastTurnId,
    isWorking: true,
    activeTurnStartedAt: time(clock - 7000),
  } satisfies Parameters<typeof deriveTranscriptRows>[0];
  return { messages, work, timeline, input, time: () => time((clock += 50)) };
}

function median(samples: number[]): number {
  const sorted = [...samples].toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function timeFullProjection(turns: number): number {
  const { input, messages, work } = syntheticThread(turns);
  const samples: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    const timeline = deriveTranscriptEntriesWithState(messages, [], work);
    deriveTranscriptRows({ ...input, timelineEntries: timeline.entries });
    samples.push(performance.now() - started);
  }
  return median(samples);
}

describe("long-thread timeline projection", () => {
  it("projects a 500-turn / 3,000-tool-call thread well inside a frame budget per token", () => {
    const thread = syntheticThread(500);
    let previousTranscript = thread.timeline;
    let projection = deriveTranscriptRowsWithState(thread.input);
    let stable = computeStableTranscriptRows(projection.rows, {
      byId: new Map(),
      result: [],
    });
    const settledRows = stable.result.slice(0, -10);

    // Simulate 50 streamed tokens into the running assistant message.
    const samples: number[] = [];
    let messages = thread.messages;
    for (let token = 0; token < 50; token += 1) {
      const last = messages.at(-1)!;
      messages = [
        ...messages.slice(0, -1),
        { ...last, text: `${last.text}token${token} `, updatedAt: thread.time() },
      ];
      const started = performance.now();
      previousTranscript = deriveTranscriptEntriesWithState(
        messages,
        [],
        thread.work,
        previousTranscript,
      );
      projection = deriveTranscriptRowsWithState(
        { ...thread.input, timelineEntries: previousTranscript.entries },
        projection,
      );
      stable = computeStableTranscriptRows(projection.rows, stable);
      samples.push(performance.now() - started);
    }

    // Settled history keeps its row identity, so memoized rows never re-render mid-stream.
    for (const [index, row] of settledRows.entries()) {
      expect(stable.result[index]).toBe(row);
    }
    const streamed = stable.result.find(
      (row) => row.kind === "message" && row.message.id === "assistant-499",
    );
    expect(streamed).toMatchObject({ message: { text: expect.stringContaining("token49") } });

    const perToken = median(samples);
    // One 60 Hz frame is ~16 ms; measured ~0.2 ms per token on an M-series Mac. Generous
    // headroom for a loaded CI box — a regression to a full rebuild costs far more.
    expect(perToken).toBeLessThan(4);
  });

  it("scales linearly with thread length (no quadratic pass)", () => {
    // Deterministic under a loaded machine (F5, 2026-10-02: a full `pnpm test` beside two live agents measured
    // 11.2x). Small and large runs are interleaved so a load spike hits both, each size keeps its BEST run (the
    // intrinsic cost; load only ever adds time), and a noisy attempt is retried — a real quadratic pass is ~16x on
    // every attempt, so it still fails.
    const small = syntheticThread(250);
    const large = syntheticThread(1000);
    const once = ({ input, messages, work }: ReturnType<typeof syntheticThread>) => {
      const started = performance.now();
      const timeline = deriveTranscriptEntriesWithState(messages, [], work);
      deriveTranscriptRows({ ...input, timelineEntries: timeline.entries });
      return performance.now() - started;
    };
    timeFullProjection(100); // warm the JIT
    const ratios: number[] = [];
    let bestLarge = Infinity;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let bestSmall = Infinity;
      let attemptLarge = Infinity;
      for (let run = 0; run < 7; run += 1) {
        bestSmall = Math.min(bestSmall, once(small));
        attemptLarge = Math.min(attemptLarge, once(large));
      }
      bestLarge = Math.min(bestLarge, attemptLarge);
      ratios.push(attemptLarge / Math.max(bestSmall, 0.5));
      if (ratios.at(-1)! < 8) break;
    }
    // 4x the turns: linear ≈ 4x, quadratic ≈ 16x. Allow noise up to 8x.
    expect(
      Math.min(...ratios),
      `ratios ${ratios.map((r) => r.toFixed(1)).join(", ")}`,
    ).toBeLessThan(8);
    // And an absolute ceiling for 1,000 turns / 6,000 tool calls from scratch (measured ~4 ms).
    expect(bestLarge).toBeLessThan(150);
  });
});
