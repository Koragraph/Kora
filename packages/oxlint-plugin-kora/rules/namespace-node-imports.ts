import { defineRule } from "@oxlint/plugins";

// Whole-module spellings that do not follow the PascalCase rule.
const SPECIAL_MODULES: Readonly<Record<string, string>> = {
  "assert/strict": "Assert",
  "fs/promises": "FSP",
};

// Path segments that are conventionally written in capitals.
const CAPITALISED_SEGMENTS: Readonly<Record<string, string>> = {
  fs: "FS",
  os: "OS",
  url: "URL",
  vm: "VM",
};

const pascalCase = (word: string): string =>
  word
    .split(/[_-]/u)
    .filter(Boolean)
    .map((part) => (part[0] ?? "").toUpperCase() + part.slice(1))
    .join("");

const expectedNamespaceAlias = (source: string): string => {
  const moduleName = source.slice("node:".length);
  const special = Object.hasOwn(SPECIAL_MODULES, moduleName) ? SPECIAL_MODULES[moduleName] : null;
  if (special) return "Node" + special;

  const segments = moduleName.split("/").map((segment) => {
    return Object.hasOwn(CAPITALISED_SEGMENTS, segment)
      ? CAPITALISED_SEGMENTS[segment]
      : pascalCase(segment);
  });
  return "Node" + segments.join("");
};

/** Reads `field` from an AST node of the given `type`, if it is a string. */
const stringFieldOf = (node: unknown, type: string, field: string): string | undefined => {
  if (typeof node !== "object" || node === null) return undefined;
  const record = node as Record<string, unknown>;
  const value = record[field];
  return record.type === type && typeof value === "string" ? value : undefined;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require canonical namespace imports for Node.js built-in modules.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = stringFieldOf(node.source, "Literal", "value");
        if (!source?.startsWith("node:")) return;

        const wanted = expectedNamespaceAlias(source);
        const [only] = node.specifiers;
        const namespaceSpecifier =
          node.specifiers.length === 1 && only?.type === "ImportNamespaceSpecifier"
            ? only
            : undefined;
        const found = stringFieldOf(namespaceSpecifier?.local, "Identifier", "name");

        if (found !== wanted) {
          context.report({ node, message: `Import ${source} as a namespace named ${wanted}.` });
        }
      },
    };
  },
});
