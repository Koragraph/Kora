// @effect-diagnostics nodeBuiltinImport:off -- test fixtures write a temp settings.json
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  claudeResolvedModels,
  effectiveClaudeDefaultAlias,
  mapClaudeModels,
  prettyClaudeId,
  withKnownClaudeModels,
} from "./claudeModels.ts";

// The Default row follows the user's own Claude setting, so every test says which one it is (never the real ~/.claude).
const pick = (rows: Parameters<typeof mapClaudeModels>[0], alias = "sonnet") =>
  mapClaudeModels(rows, alias).map((m) => [
    m.slug,
    m.name,
    m.shortName ?? null,
    m.isDefault === true,
  ]);

NodeTest.test(
  "newer SDK rows (0.3.28x): the version is in displayName, Default names what it resolves to",
  () => {
    NodeAssert.deepEqual(
      pick([
        {
          value: "default",
          resolvedModel: "claude-sonnet-5-5",
          displayName: "Default (recommended)",
          description: "Sonnet 5.5 · Efficient for routine tasks",
          supportsEffort: true,
          supportedEffortLevels: ["low", "high"],
        },
        {
          value: "opus",
          resolvedModel: "claude-opus-5-5",
          displayName: "Opus 5.5",
          description: "Best for everyday, complex tasks",
          supportsEffort: true,
          supportedEffortLevels: ["low", "high"],
        },
        {
          value: "haiku",
          resolvedModel: "claude-haiku-4-5-20251001",
          displayName: "Haiku 4.5",
          description: "Fastest for quick answers",
        },
      ]),
      [
        ["default", "Default · Sonnet", "Sonnet", true],
        ["opus", "Opus 5.5", null, false],
        ["haiku", "Haiku 4.5", null, false],
      ],
    );
  },
);

NodeTest.test("a Default row with only resolvedModel still names the model", () => {
  claudeResolvedModels.clear();
  NodeAssert.deepEqual(
    pick(
      [
        {
          value: "default",
          resolvedModel: "claude-opus-5-5",
          displayName: "Default (recommended)",
          description: "Best for everyday tasks",
        },
      ],
      "opus",
    ),
    [["default", "Default · Opus", "Opus", true]],
  );
});

NodeTest.test("older SDK rows: the version leads the description", () => {
  NodeAssert.deepEqual(
    pick([
      {
        value: "default",
        displayName: "Default",
        description: "Opus 5 with 1M context · Best for everyday tasks",
      },
      {
        value: "sonnet",
        displayName: "Sonnet",
        description: "Sonnet 5 · Efficient for routine tasks",
      },
    ]),
    [
      ["default", "Default · Sonnet 5", "Sonnet 5", true],
      ["sonnet", "Sonnet 5", null, false],
    ],
  );
});

NodeTest.test("prettyClaudeId", () => {
  NodeAssert.equal(prettyClaudeId("claude-sonnet-5-5"), "Sonnet 5.5");
  NodeAssert.equal(prettyClaudeId("claude-haiku-4-5-20251001"), "Haiku 4.5");
  NodeAssert.equal(prettyClaudeId("claude-fable-5-1[1m]"), "Fable 5.1");
  NodeAssert.equal(prettyClaudeId("claude-opus-5"), "Opus 5");
  NodeAssert.equal(prettyClaudeId("gpt-5.5"), null);
});

NodeTest.test(
  "API-key login rows: 'Use the default model (currently …)' is a tagline, not the model's name",
  () => {
    NodeAssert.deepEqual(
      pick(
        [
          {
            value: "default",
            resolvedModel: "claude-opus-5-5",
            displayName: "Default (recommended)",
            description: "Use the default model (currently Opus 5.5) · $4/$20 per Mtok",
          },
          {
            value: "opus",
            resolvedModel: "claude-opus-5-5",
            displayName: "Opus",
            description: "Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok",
          },
        ],
        "opus",
      ),
      [
        ["default", "Default · Opus 5.5", "Opus 5.5", true],
        ["opus", "Opus 5.5", null, false],
      ],
    );
  },
);

NodeTest.test(
  "aliases record the full id they resolve to (the worker catalog launches CLI workers with it)",
  () => {
    claudeResolvedModels.clear();
    mapClaudeModels([
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5-5",
        displayName: "Sonnet 5.5",
        description: "x",
      },
      {
        value: "claude-sonnet-5",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet 5",
        description: "x",
      },
    ]);
    NodeAssert.deepEqual([...claudeResolvedModels], [["sonnet", "claude-sonnet-5-5"]]);
  },
);

NodeTest.test(
  "a catalog that lacks Haiku 5.5 gets it next to Haiku 4.5; rows the SDK lists are never duplicated",
  () => {
    const rows = [
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5-5",
        displayName: "Sonnet 5.5",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
    ];
    const withKnown = withKnownClaudeModels(mapClaudeModels(rows)).map((m) => [m.slug, m.name]);
    NodeAssert.deepEqual(withKnown, [
      ["sonnet", "Sonnet 5.5"],
      ["claude-haiku-5-5", "Haiku 5.5"],
      ["haiku", "Haiku 4.5"],
      ["claude-opus-5-5", "Opus 5.5"],
    ]);
    // a newer Claude Code that lists Haiku 5.5 itself: ours steps aside
    const newer = withKnownClaudeModels(
      mapClaudeModels([...rows, { value: "claude-haiku-5-5", displayName: "Haiku 5.5" }]),
    );
    NodeAssert.equal(newer.filter((m) => m.slug === "claude-haiku-5-5").length, 1);
  },
);

NodeTest.test(
  "Default follows the user's Claude setting and records the full id workers launch with",
  () => {
    claudeResolvedModels.clear();
    const rows = [
      {
        value: "default",
        resolvedModel: "claude-opus-5-5",
        displayName: "Default (recommended)",
        description: "x",
      },
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5-5",
        displayName: "Sonnet 5.5",
        description: "x",
      },
      {
        value: "opus",
        resolvedModel: "claude-opus-5-5",
        displayName: "Opus 5.5",
        description: "x",
      },
    ];
    NodeAssert.deepEqual(pick(rows, "sonnet")[0], [
      "default",
      "Default · Sonnet 5.5",
      "Sonnet 5.5",
      true,
    ]);
    NodeAssert.equal(claudeResolvedModels.get("default"), "claude-sonnet-5-5");
    // an explicit Opus pick is untouched, and a user who set opus keeps Opus
    NodeAssert.deepEqual(pick(rows, "opus")[2], ["opus", "Opus 5.5", null, false]);
    NodeAssert.deepEqual(pick(rows, "opus")[0], [
      "default",
      "Default · Opus 5.5",
      "Opus 5.5",
      true,
    ]);
    NodeAssert.equal(claudeResolvedModels.get("default"), "claude-opus-5-5");
    NodeAssert.equal(pick(rows, "sonnet[1m]")[0]![1], "Default · Sonnet 5.5 (1M context)");
  },
);

NodeTest.test("effectiveClaudeDefaultAlias: the user's settings.json model, else sonnet", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-claude-cfg-"));
  NodeAssert.equal(effectiveClaudeDefaultAlias(dir), "sonnet");
  NodeFS.writeFileSync(NodePath.join(dir, "settings.json"), JSON.stringify({ model: "opus" }));
  NodeAssert.equal(effectiveClaudeDefaultAlias(dir), "opus");
  NodeFS.writeFileSync(NodePath.join(dir, "settings.json"), JSON.stringify({ model: "default" }));
  NodeAssert.equal(effectiveClaudeDefaultAlias(dir), "sonnet");
  NodeFS.rmSync(dir, { recursive: true, force: true });
});
