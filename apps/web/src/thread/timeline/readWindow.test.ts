import { EventId, TurnId, type ChatThreadActivity } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveActivityRows } from "./index";
import { boundedReadLabel } from "../../components/thread/transcriptWorkRows";

const act = (
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  summary = "Read /repo/src/big.ts",
): ChatThreadActivity => ({
  id: EventId.make(id),
  createdAt: "2026-10-14T10:00:00.000Z",
  kind,
  summary,
  tone: "tool",
  payload,
  turnId: TurnId.make("turn-1"),
});

describe("a Read Kora bounded", () => {
  it("carries its window from the daemon's tool_result onto the merged Read row", () => {
    const entries = deriveActivityRows([
      act("a1", "file_read", {
        itemId: "tu1",
        toolName: "Read",
        input: { file_path: "/repo/src/big.ts" },
      }),
      act(
        "a2",
        "tool_result",
        {
          itemId: "tu1",
          status: "completed",
          output: "1\tline",
          bounded: { path: "/repo/src/big.ts", offset: 284, limit: 120, total: 602 },
        },
        "tool completed",
      ),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.readWindow).toEqual({
      path: "/repo/src/big.ts",
      offset: 284,
      limit: 120,
      total: 602,
    });
  });

  it("a Read the agent windowed itself has no chip", () => {
    const entries = deriveActivityRows([
      act("b1", "file_read", {
        itemId: "tu2",
        toolName: "Read",
        input: { file_path: "/repo/src/big.ts", offset: 10, limit: 20 },
      }),
      act(
        "b2",
        "tool_result",
        { itemId: "tu2", status: "completed", output: "x" },
        "tool completed",
      ),
    ]);
    expect(entries[0]!.readWindow).toBeUndefined();
  });

  it("the chip reads in plain words and clamps to the file's end", () => {
    expect(boundedReadLabel({ offset: 284, limit: 120, total: 1840 })).toBe(
      "read lines 284–403 of 1,840",
    );
    expect(boundedReadLabel({ offset: 500, limit: 250, total: 602 })).toBe(
      "read lines 500–602 of 602",
    );
  });
});
