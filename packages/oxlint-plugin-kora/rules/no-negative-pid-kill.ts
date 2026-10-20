import * as Option from "effect/Option";
import { defineRule } from "@oxlint/plugins";

import { getPropertyName, isIdentifier, isWindowsAware, unwrapExpression } from "../utils.ts";

const MESSAGE =
  "process.kill(-pid) signals a POSIX process group; Windows has none (it throws ESRCH/EINVAL and the tree survives). Add a win32 branch: killTreeWindows(pid) from util/win-exec.ts.";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow process-group kills (`process.kill(-pid)`) in functions without a Windows branch.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return;
        if (!isIdentifier(unwrapExpression(callee.value.object), "process")) return;
        if (Option.getOrUndefined(getPropertyName(callee.value.property)) !== "kill") return;
        const target = unwrapExpression(node.arguments[0]);
        if (Option.isNone(target)) return;
        const negative =
          (target.value.type === "UnaryExpression" && target.value.operator === "-") ||
          (target.value.type === "Literal" &&
            typeof target.value.value === "number" &&
            target.value.value < 0);
        if (!negative || isWindowsAware(context.sourceCode, node)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
