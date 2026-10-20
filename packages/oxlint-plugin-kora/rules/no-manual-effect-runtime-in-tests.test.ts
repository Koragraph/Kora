import { expect } from "vite-plus/test";

import { lintRule } from "../test/utils.ts";

const header = `import * as Effect from "effect/Effect";\n`;
const inTest = lintRule("kora/no-manual-effect-runtime-in-tests", { filename: "thing.test.ts" });

inTest.allows("it.effect tests", `${header}it.effect("works", () => Effect.succeed(1));`);
inTest.allows(
  "building an effect without running it",
  `${header}const job = Effect.map(Effect.succeed(1), (n) => n + 1);`,
);
inTest.allows("a run method on something that is not Effect", `${header}worker.runPromise(job);`);

inTest.reports(
  "Effect.runPromise",
  `${header}await Effect.runPromise(Effect.succeed(1));`,
  (output) => expect(output).toContain("Do not use Effect.runPromise in tests"),
);
inTest.reports("Effect.runSync", `${header}Effect.runSync(Effect.void);`);
inTest.reports("Effect.runForkWith", `${header}Effect.runForkWith(services)(Effect.void);`);
inTest.reports(
  "ManagedRuntime.make",
  `import * as ManagedRuntime from "effect/ManagedRuntime";\nManagedRuntime.make(layer);`,
  (output) => expect(output).toContain("Do not use ManagedRuntime.make in tests"),
);

lintRule("kora/no-manual-effect-runtime-in-tests", { filename: "src/thing.ts" }).allows(
  "running an effect outside a test file",
  `${header}Effect.runSync(Effect.void);`,
);

// Files with known debt get a ceiling: up to it is fine, one more is reported.
const withDebt = (n: number) =>
  lintRule("kora/no-manual-effect-runtime-in-tests", {
    filename: "old.test.ts",
    options: [{ maxOccurrences: n }],
  });
withDebt(2).allows(
  "two runs under a ceiling of two",
  `${header}Effect.runSync(Effect.void);\nEffect.runSync(Effect.void);`,
);
withDebt(1).reports(
  "two runs over a ceiling of one",
  `${header}Effect.runSync(Effect.void);\nEffect.runSync(Effect.void);`,
);
