import { describe, expect, it } from "vite-plus/test";
import type { ChatThreadActivity } from "@kora/contracts";
import {
  derivePendingWorkerPicker,
  effortsFor,
  pickerAgentOptions,
  pickerAnswer,
  rowsEdited,
  unavailableRows,
  updateRow,
  type WorkerCatalogAgents,
} from "./workerPicker.logic";

const catalog: WorkerCatalogAgents = {
  claude: {
    installed: true,
    models: [
      { id: "default", isDefault: true, efforts: ["low", "high"] },
      { id: "haiku", efforts: [] },
    ],
  },
  codex: {
    installed: true,
    models: [{ id: "gpt-5.5", isDefault: true, efforts: ["low", "medium"] }],
  },
  gemini: { installed: false, models: [] },
};
const act = (kind: string, payload: Record<string, unknown>) =>
  ({ kind, payload, createdAt: "2026-10-01T00:00:00Z" }) as unknown as ChatThreadActivity;

describe("worker picker logic", () => {
  it("the open picker is the newest request with no resolved", () => {
    const req = act("worker-picker.requested", {
      requestId: "wp_1",
      picks: [{ title: "a", agent: "codex" }, { bogus: 1 }],
      catalog,
    });
    expect(derivePendingWorkerPicker([req])).toEqual({
      requestId: "wp_1",
      picks: [{ title: "a", agent: "codex" }],
      catalog,
    });
    expect(
      derivePendingWorkerPicker([req, act("worker-picker.resolved", { requestId: "wp_1" })]),
    ).toBeNull();
    expect(derivePendingWorkerPicker([])).toBeNull();
  });

  it("lists installed agents with a free/plan tag, plus proposed ones marked when not installed", () => {
    expect(
      pickerAgentOptions({ ...catalog, opencode: { installed: true, models: [] } }, [
        { title: "x", agent: "gemini" },
      ]),
    ).toEqual([
      { id: "claude", label: "Claude Code · your plan", disabled: false },
      { id: "codex", label: "Codex · your plan", disabled: false },
      { id: "opencode", label: "OpenCode · free", disabled: false },
      { id: "gemini", label: "Gemini CLI · not installed", disabled: true },
    ]);
  });

  it("never offers Codex when the catalog is empty", () => {
    expect(pickerAgentOptions({}, []).map((o) => o.id)).toEqual(["claude"]);
    expect(pickerAgentOptions({}, [{ title: "x", agent: "codex" }])).toEqual([
      { id: "claude", label: "Claude Code · your plan", disabled: false },
      { id: "codex", label: "Codex · your plan", disabled: false },
    ]);
  });

  it("flags rows whose agent is not installed", () => {
    expect(
      unavailableRows(catalog, [
        { title: "a", agent: "claude" },
        { title: "b", agent: "gemini" },
        { title: "c", agent: "cursor" },
      ]),
    ).toEqual([1, 2]);
    expect(unavailableRows({}, [{ title: "a", agent: "codex" }])).toEqual([]);
  });

  it("knows when the human edited the proposal", () => {
    const proposed = [{ title: "a", agent: "claude", model: "haiku" }];
    expect(rowsEdited(proposed, [{ ...proposed[0]! }])).toBe(false);
    expect(rowsEdited(proposed, [{ title: "a", agent: "codex" }])).toBe(true);
    expect(rowsEdited(proposed, [])).toBe(true);
  });

  it("changing the agent clears a model and effort that belong to the old one", () => {
    const row = { title: "a", agent: "codex", model: "gpt-5.5", effort: "medium" };
    expect(updateRow(catalog, row, { agent: "claude" })).toEqual({ title: "a", agent: "claude" });
  });

  it("picking a model without effort levels drops the effort", () => {
    const row = { title: "a", agent: "claude", effort: "high" };
    expect(updateRow(catalog, row, { model: "haiku" })).toEqual({
      title: "a",
      agent: "claude",
      model: "haiku",
    });
    expect(effortsFor(catalog, "claude", undefined)).toEqual(["low", "high"]);
  });

  it("the answer carries only what the daemon reads", () => {
    expect(
      pickerAnswer([{ title: "a", agent: "codex", model: "gpt-5.5", why: "x" }], true),
    ).toEqual({
      picks: [{ title: "a", agent: "codex", model: "gpt-5.5" }],
      autoApprove: true,
    });
  });
});
