import * as Option from "effect/Option";
import type { ESTree, SourceCode } from "@oxlint/plugins";

type AstNode = ESTree.Node;

type ExpressionWrapper =
  | ESTree.TSTypeAssertion
  | ESTree.TSAsExpression
  | ESTree.TSNonNullExpression
  | ESTree.ParenthesizedExpression
  | ESTree.ChainExpression;

const WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSNonNullExpression",
  "TSAsExpression",
  "TSTypeAssertion",
]);

const asAstNode = (node: unknown): Option.Option<AstNode> => {
  const looksLikeNode = typeof node === "object" && node !== null && "type" in node;
  return looksLikeNode && typeof node.type === "string"
    ? Option.some(node as AstNode)
    : Option.none();
};

const isExpressionWrapper = (node: AstNode): node is ExpressionWrapper =>
  WRAPPER_TYPES.has(node.type);

export function unwrapExpression(node: unknown): Option.Option<AstNode> {
  let found = asAstNode(node);
  for (; Option.isSome(found) && isExpressionWrapper(found.value);) {
    found = asAstNode(found.value.expression);
  }
  return found;
}

export function getPropertyName(node: unknown): Option.Option<string> {
  return Option.flatMap(asAstNode(node), (candidate) => {
    switch (candidate.type) {
      case "Identifier":
      case "PrivateIdentifier":
        return typeof candidate.name === "string" ? Option.some(candidate.name) : Option.none();
      case "Literal":
        return typeof candidate.value === "string" ? Option.some(candidate.value) : Option.none();
      default:
        return Option.none();
    }
  });
}

export function isIdentifier(node: Option.Option<AstNode>, name?: string): boolean {
  if (!Option.isSome(node)) return false;
  const target = node.value;
  if (target.type !== "Identifier" || typeof target.name !== "string") return false;
  return name === undefined ? true : target.name === name;
}

/** The value of a string literal or an expression-free template literal. */
export function staticString(node: unknown): Option.Option<string> {
  return Option.flatMap(unwrapExpression(node), (candidate) => {
    if (candidate.type === "Literal" && typeof candidate.value === "string") {
      return Option.some(candidate.value);
    }
    if (candidate.type === "TemplateLiteral" && candidate.expressions.length === 0) {
      const cooked = candidate.quasis[0]?.value.cooked;
      return typeof cooked === "string" ? Option.some(cooked) : Option.none();
    }
    return Option.none();
  });
}

/** `spawn` for `spawn(…)`, `cp.spawn(…)` and `childProcess["spawn"](…)`. */
export function calleeName(callee: unknown): Option.Option<string> {
  return Option.flatMap(unwrapExpression(callee), (target) => {
    if (target.type === "Identifier") return Option.some(target.name);
    if (target.type === "MemberExpression") return getPropertyName(target.property);
    return Option.none();
  });
}

// Text that marks a Windows branch: `process.platform === 'win32'`, a `win`/`isWindows` flag, the tree-kill helper.
const WINDOWS_MARK = /win32|\bisWin(?:dows)?\b|\bwin\b|\bIS_WIN(?:DOWS)?\b|killTreeWindows/u;

const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** The ancestors of `node`, root first (as `sourceCode.getAncestors`), typed as ESTree nodes. */
export function ancestorsOf(sourceCode: SourceCode, node: AstNode): AstNode[] {
  return sourceCode.getAncestors(node).flatMap((ancestor) => Option.toArray(asAstNode(ancestor)));
}

/**
 * True when `node` sits under a condition that mentions Windows (`win ? gitBash() : '/bin/sh'`,
 * `if (process.platform !== 'win32') …`), or when its enclosing function mentions Windows anywhere (an early
 * `if (win) { killTreeWindows(pid); return; }`). Module-level code only counts enclosing conditions.
 */
export function isWindowsAware(sourceCode: SourceCode, node: AstNode): boolean {
  const ancestors = ancestorsOf(sourceCode, node);
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    if (ancestor === undefined) continue;
    if (FUNCTION_TYPES.has(ancestor.type)) return WINDOWS_MARK.test(sourceCode.getText(ancestor));
    if (
      (ancestor.type === "IfStatement" || ancestor.type === "ConditionalExpression") &&
      WINDOWS_MARK.test(sourceCode.getText(ancestor.test))
    ) {
      return true;
    }
    if (
      ancestor.type === "LogicalExpression" &&
      WINDOWS_MARK.test(sourceCode.getText(ancestor.left))
    ) {
      return true;
    }
  }
  return false;
}
