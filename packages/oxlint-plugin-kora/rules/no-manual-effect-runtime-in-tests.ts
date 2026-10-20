import * as Option from "effect/Option";
import { defineRule } from "@oxlint/plugins";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const RUN_VARIANTS = ["Callback", "Fork", "Promise", "PromiseExit", "Sync", "SyncExit"];
const EFFECT_RUNTIME_METHODS: ReadonlySet<string> = new Set(
  RUN_VARIANTS.flatMap((variant) => [`run${variant}`, `run${variant}With`]),
);

// Existing manual runners are tracked as debt through the `maxOccurrences`
// option, set per file in the lint config. The rule permits no net-new
// occurrences in those files, while every other test file must have zero.
const readMaxOccurrences = (options: ReadonlyArray<unknown>): number => {
  const configured = options[0];
  if (typeof configured !== "object" || configured === null) return 0;
  const ceiling = "maxOccurrences" in configured ? configured.maxOccurrences : undefined;
  return typeof ceiling === "number" ? ceiling : 0;
};

const manualRunnerName = (callee: unknown): Option.Option<string> => {
  const target = unwrapExpression(callee);
  if (!Option.isSome(target) || target.value.type !== "MemberExpression") return Option.none();

  const owner = unwrapExpression(target.value.object);
  const method = getPropertyName(target.value.property);
  if (!Option.isSome(method)) return Option.none();

  const methodName = method.value;
  if (isIdentifier(owner, "Effect") && EFFECT_RUNTIME_METHODS.has(methodName)) {
    return Option.some("Effect." + methodName);
  }
  if (isIdentifier(owner, "ManagedRuntime") && methodName === "make") {
    return Option.some("ManagedRuntime.make");
  }
  return Option.none();
};

const DOC_TEXT =
  "Disallow manually creating or running Effect runtimes in tests; use @effect/vitest.";

const maxOccurrencesSchema = {
  description: "Legacy debt ceiling for this file: occurrences beyond this count are reported.",
  minimum: 0,
  type: "integer",
} as const;

const optionsSchema = {
  additionalProperties: false,
  properties: { maxOccurrences: maxOccurrencesSchema },
  type: "object",
} as const;

export default defineRule({
  meta: {
    docs: { description: DOC_TEXT },
    defaultOptions: [{ maxOccurrences: 0 }],
    schema: [optionsSchema],
    type: "problem",
  },
  create(context) {
    if (!TEST_FILE_PATTERN.test(context.filename)) return {};

    const allowance = readMaxOccurrences(context.options);
    let seen = 0;

    return {
      CallExpression(node) {
        const runner = manualRunnerName(node.callee);
        if (!Option.isSome(runner)) return;

        seen += 1;
        if (seen > allowance) {
          context.report({
            node: node.callee,
            message: `Do not use ${runner.value} in tests. Use @effect/vitest with it.effect(...) and test layers instead.`,
          });
        }
      },
    };
  },
});
