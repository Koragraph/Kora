import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  autoModelPreselect,
  mapClaudeModels,
  withAutoModel,
  withKnownClaudeModels,
} from "./claudeModels.ts";

const rows = [
  {
    value: "default",
    displayName: "Default",
    description: "Use the default model",
    resolvedModel: "claude-sonnet-5-5",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    value: "sonnet",
    displayName: "Sonnet 5.5",
    description: "Everyday",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
];

NodeTest.test("Auto off (the default): no Auto row, Default stays the preselected row", () => {
  const out = withAutoModel(withKnownClaudeModels(mapClaudeModels(rows as never, "sonnet")));
  NodeAssert.equal(
    out.some((m) => m.slug === "auto"),
    false,
  );
  NodeAssert.equal(out.find((m) => m.isDefault)!.slug, "default");
});

NodeTest.test("Auto on: Auto leads the list with the Default's effort levels, once", () => {
  const out = withAutoModel(withKnownClaudeModels(mapClaudeModels(rows as never, "sonnet")), true);
  NodeAssert.equal(out[0]!.slug, "auto");
  NodeAssert.equal(out[0]!.shortName, "Auto");
  NodeAssert.deepEqual(out[0]!.capabilities, out.find((m) => m.slug === "default")!.capabilities);
  NodeAssert.equal(
    withAutoModel(out, true).filter((m) => m.slug === "auto").length,
    1,
    "idempotent",
  );
});

NodeTest.test("Auto on: Auto is the one preselected row (new threads start on it)", () => {
  const out = withAutoModel(withKnownClaudeModels(mapClaudeModels(rows as never, "sonnet")), true);
  NodeAssert.deepEqual(
    out.filter((m) => m.isDefault).map((m) => m.slug),
    ["auto"],
  );
  NodeAssert.deepEqual(
    withAutoModel(out, true)
      .filter((m) => m.isDefault)
      .map((m) => m.slug),
    ["auto"],
    "idempotent",
  );
});

NodeTest.test(
  "autoModelPreselect: the setting, overridden by KORA_AUTO_MODEL like the runtime",
  () => {
    NodeAssert.equal(autoModelPreselect(undefined, {}), false);
    NodeAssert.equal(autoModelPreselect(false, {}), false);
    NodeAssert.equal(autoModelPreselect(true, { KORA_AUTO_MODEL: "0" }), false);
    NodeAssert.equal(autoModelPreselect(false, { KORA_AUTO_MODEL: "on" }), true);
  },
);
