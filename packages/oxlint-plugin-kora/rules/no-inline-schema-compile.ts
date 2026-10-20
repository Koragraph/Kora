import * as Option from "effect/Option";
import type { ESTree } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const COMPILE_KINDS = ["is", "asserts"];
const COMPILE_VERBS = ["decode", "encode"];
const COMPILE_FORMS = ["Exit", "Effect", "Option", "Promise", "Result", "Sync"];
const COMPILERS: ReadonlySet<string> = new Set([
  ...COMPILE_KINDS,
  ...COMPILE_VERBS.flatMap((verb) =>
    COMPILE_FORMS.flatMap((form) => [verb + form, verb + "Unknown" + form]),
  ),
]);

/** The method name when `callee` is `Schema.<method>`. */
const schemaMethodOf = (callee: unknown): string | undefined => {
  const member = unwrapExpression(callee);
  if (!Option.isSome(member) || member.value.type !== "MemberExpression") return undefined;
  const onSchema = isIdentifier(unwrapExpression(member.value.object), "Schema");
  return onSchema ? Option.getOrUndefined(getPropertyName(member.value.property)) : undefined;
};

const isStaticReference = (arg: unknown): boolean => {
  const unwrapped = unwrapExpression(arg);
  if (!Option.isSome(unwrapped)) return false;
  const { value } = unwrapped;
  return (
    value.type === "MemberExpression" || (value.type === "Identifier" && /^[A-Z]/u.test(value.name))
  );
};

/** A schema built on the spot: `Schema.Something(...)`. */
const isStaticSchemaCall = (arg: unknown): boolean => {
  const unwrapped = unwrapExpression(arg);
  if (!Option.isSome(unwrapped) || unwrapped.value.type !== "CallExpression") return false;
  const method = schemaMethodOf(unwrapped.value.callee);
  if (method === undefined) return false;
  if (method !== "fromJsonString") return true;
  // fromJsonString only counts when what it wraps is itself static.
  const [inner] = unwrapped.value.arguments;
  return inner !== undefined && (isStaticReference(inner) || isStaticSchemaCall(inner));
};

const messageFor = (method: string, severity: "high" | "medium"): string => {
  const head = `Hoist Schema.${method}(...) to module scope: `;
  return severity === "high"
    ? head +
        "both the inline schema literal and the compiled function are rebuilt on every call. Move the compiled function to a module-level const."
    : head + "the compiled function is rebuilt on every call. Move it to a module-level const.";
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Schema decoder/encoder compiler calls inside function bodies; hoist them to module scope.",
    },
  },
  createOnce(context) {
    let functionDepth = 0;
    const enter = () => void (functionDepth += 1);
    const leave = () => void (functionDepth -= 1);

    return {
      before() {
        functionDepth = 0;
      },
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": leave,
      FunctionExpression: enter,
      "FunctionExpression:exit": leave,
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": leave,

      CallExpression(node) {
        if (functionDepth < 1) return;
        const method = schemaMethodOf(node.callee);
        if (method === undefined || !COMPILERS.has(method)) return;

        // Only `Schema.decodeX(S)(input)` is flagged: the compiled function is
        // thrown away right after use. Keeping it in a local is a different matter.
        const parent = node.parent as ESTree.Node | null | undefined;
        if (parent?.type !== "CallExpression" || parent.callee !== node) return;

        const first = node.arguments[0];
        const severity = isStaticSchemaCall(first) ? "high" : "medium";
        if (severity === "medium" && !isStaticReference(first)) return;

        context.report({ node: node.callee, message: messageFor(method, severity) });
      },
    };
  },
});
