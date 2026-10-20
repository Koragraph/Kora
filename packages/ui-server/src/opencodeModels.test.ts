import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { applyOpencodeFreeModels } from "./blobsEngine.ts";
import { daemonConfig } from "./config.ts";
import { parseOpencodeVerbose, setOpencodeListedModelsForTests } from "./opencodeModels.ts";

const block = (id: string, body: object) => `${id}\n${JSON.stringify(body, null, 2)}\n`;

const VERBOSE =
  block("opencode/big-pickle", {
    providerID: "opencode",
    name: "Big Pickle",
    cost: { input: 0, output: 0 },
    variants: {},
  }) +
  block("opencode/muse-free", {
    providerID: "opencode",
    name: "Muse Free",
    cost: { input: 0, output: 0 },
    variants: { xhigh: {}, low: {}, minimal: {}, high: {}, medium: {} },
  }) +
  block("opencode/claude-x", {
    providerID: "opencode",
    name: "Claude X",
    cost: { input: 3, output: 15 },
    variants: { high: {}, low: {} },
  }) +
  block("anthropic/old", {
    providerID: "anthropic",
    name: "Old",
    status: "deprecated",
    cost: { input: 1, output: 1 },
  }) +
  "opencode/broken\n{ not json\n";

NodeTest.test(
  "opencode models --verbose: ids, cost, sorted variants; deprecated and broken blocks dropped",
  () => {
    const got = parseOpencodeVerbose(VERBOSE);
    NodeAssert.deepEqual(
      got.map((m) => [m.id, m.free, m.variants.join(",")]),
      [
        ["opencode/big-pickle", true, ""],
        ["opencode/muse-free", true, "minimal,low,medium,high,xhigh"],
        ["opencode/claude-x", false, "low,high"],
      ],
    );
  },
);

NodeTest.test(
  "the OpenCode tab: swarm free models first, then the user's own, each with its effort levels",
  () => {
    setOpencodeListedModelsForTests(parseOpencodeVerbose(VERBOSE));
    applyOpencodeFreeModels({
      ready: true,
      models: {
        available: [{ id: "opencode/big-pickle", label: "Big Pickle", rank: 1 }],
        cooling: [],
      },
    } as unknown as Parameters<typeof applyOpencodeFreeModels>[0]);
    const entry = (
      daemonConfig.providers as unknown as Array<{
        instanceId: string;
        displayName: string;
        models: any[];
      }>
    ).find((p) => p.instanceId === "opencode")!;
    NodeAssert.equal(entry.displayName, "OpenCode");
    NodeAssert.deepEqual(
      entry.models.map((m) => [m.slug, m.subProvider ?? null, m.isDefault === true]),
      [
        ["opencode/big-pickle", null, true],
        ["opencode/muse-free", null, false],
        ["opencode/claude-x", "Zen", false],
      ],
    );
    NodeAssert.deepEqual(entry.models[0].capabilities.optionDescriptors, []);
    const effort = entry.models[1].capabilities.optionDescriptors[0];
    NodeAssert.equal(effort.id, "effort");
    NodeAssert.equal(effort.currentValue, "medium");
    NodeAssert.deepEqual(
      effort.options.map((o: { label: string }) => o.label),
      ["Minimal", "Low", "Medium", "High", "Extra High"],
    );
    setOpencodeListedModelsForTests([]);
  },
);
