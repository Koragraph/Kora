import * as Option from "effect/Option";
import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { ancestorsOf, calleeName, isWindowsAware } from "../utils.ts";

// Paths that exist only on macOS/Linux. Git for Windows maps them inside its own bash, but Node on Windows resolves
// them against the current drive (`C:\tmp`, `C:\bin\sh`), which is missing.
const EXACT: ReadonlySet<string> = new Set([
  "/bin/sh",
  "/bin/bash",
  "/bin/zsh",
  "/usr/bin/env",
  "/tmp",
  "/dev/null",
]);
const PREFIX = "/tmp/";

// Calls that take a POSIX shell path and translate it themselves.
const DEFAULT_ALLOWED_CALLEES = ["wrapReadDeny"];
const PASS_THROUGH: ReadonlySet<string> = new Set([
  "LogicalExpression",
  "ConditionalExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
]);

const messageFor = (value: string): string =>
  value.startsWith("/tmp")
    ? `'${value}' does not exist on Windows. Use os.tmpdir() (or fs.mkdtemp under it).`
    : value === "/dev/null"
      ? `'/dev/null' does not exist on Windows. Use os.devNull.`
      : `'${value}' does not exist on Windows. Use shellCommand()/userShell()/gitBash() from util/win-exec.ts, or put it under a win32 branch.`;

const readAllowedCallees = (options: ReadonlyArray<unknown>): ReadonlySet<string> => {
  const configured = options[0];
  const extra =
    typeof configured === "object" && configured !== null && "allowCallees" in configured
      ? configured.allowCallees
      : undefined;
  return new Set([
    ...DEFAULT_ALLOWED_CALLEES,
    ...(Array.isArray(extra) ? extra.filter((n): n is string => typeof n === "string") : []),
  ]);
};

const optionsSchema = {
  additionalProperties: false,
  properties: {
    allowCallees: {
      description: "Calls whose arguments may name POSIX paths (they translate them).",
      items: { type: "string" },
      type: "array",
    },
  },
  type: "object",
} as const;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hard-coded POSIX-only paths (/bin/sh, /tmp, /dev/null, …) outside a Windows-aware branch.",
    },
    schema: [optionsSchema],
  },
  create(context) {
    const allowed = readAllowedCallees(context.options);

    const check = (node: ESTree.Node, value: string) => {
      if (!EXACT.has(value) && !value.startsWith(PREFIX)) return;
      const ancestors = ancestorsOf(context.sourceCode, node);
      const parent = ancestors.at(-1);
      // The argument itself, or a fallback inside it (`wrapReadDeny('check', shell ?? '/bin/sh', …)`).
      const call = ancestors.findLast((a) => !PASS_THROUGH.has(a.type));
      if (call?.type === "CallExpression") {
        const name = Option.getOrUndefined(calleeName(call.callee));
        if (name !== undefined && allowed.has(name)) return;
      }
      // An import/require specifier or a type position is not a path on disk.
      if (parent?.type === "ImportDeclaration" || parent?.type === "TSLiteralType") return;
      if (isWindowsAware(context.sourceCode, node)) return;
      context.report({ node, message: messageFor(value) });
    };

    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateLiteral(node) {
        const head = node.quasis[0]?.value.cooked;
        if (typeof head !== "string") return;
        // `${dir}/x` never starts with /tmp; `/tmp/${name}` does.
        check(node, node.expressions.length === 0 ? head : head.startsWith(PREFIX) ? head : "");
      },
    };
  },
});
