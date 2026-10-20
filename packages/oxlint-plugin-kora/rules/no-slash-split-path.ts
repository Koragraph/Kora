import * as Option from "effect/Option";
import { defineRule } from "@oxlint/plugins";

import { getPropertyName, staticString, unwrapExpression } from "../utils.ts";

// Receivers that look like file-system paths. Model ids ("anthropic/claude"), URLs, branch names and routes are split
// on '/' legitimately, so they are left alone.
const PATHY =
  /path|dir|file|cwd|root|folder|home|worktree|\brel\b|\babs\b|\.relative\(|\.resolve\(|\.join\(/iu;
const NOT_A_PATH = /url|href|model|branch|\bref|route|slug|uri|origin|pathname/iu;

const MESSAGE =
  "Splitting a file-system path on '/' breaks on Windows ('C:\\Users\\me\\repo' is one segment). Use path.sep, split(/[\\\\/]/), path.basename/dirname/parse, or path.relative(...).split(path.sep).";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow `.split('/')` on values that look like file-system paths.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return;
        if (Option.getOrUndefined(getPropertyName(callee.value.property)) !== "split") return;
        if (Option.getOrUndefined(staticString(node.arguments[0])) !== "/") return;
        const receiver = context.sourceCode.getText(callee.value.object);
        if (!PATHY.test(receiver) || NOT_A_PATH.test(receiver)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
