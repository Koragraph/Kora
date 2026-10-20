import { describe, expect, test } from "vite-plus/test";

import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";

type Row = Parameters<typeof scoreModelPickerSearch>[0];

const opus = (over: Partial<Row> = {}): Row => ({
  name: "Claude Opus 4.7",
  providerDisplayName: "Claude",
  driverKind: "claude",
  ...over,
});
const copilotOpus: Row = {
  name: "Claude Opus 4.7",
  subProvider: "GitHub Copilot",
  providerDisplayName: "opencode",
  driverKind: "opencode",
};

// Lower score = better match; null = no match.
const score = (row: Row, query: string) => scoreModelPickerSearch(row, query);

describe("scoreModelPickerSearch", () => {
  test("the provider instance's display name is searchable", () => {
    const codex: Row = {
      name: "GPT-5 Codex",
      providerDisplayName: "Codex Personal",
      driverKind: "codex",
    };
    expect(score(codex, "personal")).not.toBeNull();
  });

  test("every query token must match something", () => {
    const codex: Row = { name: "GPT-5 Codex", providerDisplayName: "codex", driverKind: "codex" };
    expect(score(codex, "coplt op")).toBeNull();
  });

  test("typos in a multi-token query still match", () => {
    expect(score(copilotOpus, "coplt op")).not.toBeNull();
  });

  test("exact tokens beat fuzzy ones", () => {
    expect(score(copilotOpus, "copilot opus")!).toBeLessThan(score(copilotOpus, "coplt op")!);
  });

  test("a favourite is boosted for a partial query", () => {
    const cursor = { name: "Opus 4.5", providerDisplayName: "Cursor", driverKind: "cursor" } as Row;
    expect(score(opus({ isFavorite: true }), "opu")!).toBeLessThan(score(cursor, "opu")!);
  });

  test("but the boost cannot beat a clearly better text match", () => {
    const exactElsewhere = {
      name: "Opus 4.7",
      providerDisplayName: "Cursor",
      driverKind: "cursor",
    } as Row;
    const favourite = score(opus({ isFavorite: true }), "opus 4.7")!;
    expect(score(exactElsewhere, "opus 4.7")!).toBeLessThan(favourite);
  });
});

describe("buildModelPickerSearchText", () => {
  test("is lowercase text assembled from the generic fields", () => {
    expect(buildModelPickerSearchText(copilotOpus)).toBe(
      "claude opus 4.7 github copilot opencode opencode",
    );
  });
});
