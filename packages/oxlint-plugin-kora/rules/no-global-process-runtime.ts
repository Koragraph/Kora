import * as Option from "effect/Option";
import { defineRule } from "@oxlint/plugins";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

type HostProperty = "arch" | "platform";

const asHostProperty = (name: string): HostProperty | undefined => {
  switch (name) {
    case "platform":
    case "arch":
      return name;
    default:
      return undefined;
  }
};

const replacementFor = (property: HostProperty) =>
  property === "arch"
    ? { reference: "MachineArchitecture", source: "process.arch" }
    : { reference: "MachinePlatform", source: "process.platform" };

const messageFor = (property: HostProperty): string => {
  const { reference, source } = replacementFor(property);
  return `Use ${reference} instead of ${source}; inject the runtime reference in Effect code and provide it explicitly in tests.`;
};

const OS_MODULES = new Set(["node:os", "os"]);

/** `process` or `globalThis.process`, looking through parens / TS wrappers. */
const isProcessObject = (candidate: unknown): boolean => {
  const node = unwrapExpression(candidate);
  if (isIdentifier(node, "process")) return true;
  if (Option.isNone(node) || node.value.type !== "MemberExpression") return false;
  const member = node.value;
  return (
    isIdentifier(unwrapExpression(member.object), "globalThis") &&
    Option.getOrUndefined(getPropertyName(member.property)) === "process"
  );
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct host runtime platform/architecture reads; the shared host process references are exempted in the lint config.",
    },
  },
  createOnce(context) {
    // Bindings that came from the `os` module in the file being linted.
    const osNamespaces = new Set<string>();
    const osNamedImports = new Map<string, HostProperty>();

    return {
      before() {
        osNamespaces.clear();
        osNamedImports.clear();
      },

      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string" || !OS_MODULES.has(source)) return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportNamespaceSpecifier" ||
            specifier.type === "ImportDefaultSpecifier"
          ) {
            osNamespaces.add(specifier.local.name);
          } else if (specifier.type === "ImportSpecifier") {
            const imported = asHostProperty(
              Option.getOrElse(getPropertyName(specifier.imported), () => ""),
            );
            if (imported !== undefined) osNamedImports.set(specifier.local.name, imported);
          }
        }
      },

      MemberExpression(node) {
        const property = Option.flatMap(getPropertyName(node.property), (name) =>
          Option.fromNullishOr(asHostProperty(name)),
        );
        if (Option.isNone(property) || !isProcessObject(node.object)) return;
        context.report({ node, message: messageFor(property.value) });
      },

      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee)) return;
        const target = callee.value;

        if (target.type === "Identifier") {
          const property = osNamedImports.get(target.name);
          if (property !== undefined) context.report({ node, message: messageFor(property) });
          return;
        }

        if (target.type === "MemberExpression") {
          const object = unwrapExpression(target.object);
          if (Option.isNone(object) || object.value.type !== "Identifier") return;
          if (!osNamespaces.has(object.value.name)) return;
          const property = Option.flatMap(getPropertyName(target.property), (name) =>
            Option.fromNullishOr(asHostProperty(name)),
          );
          if (Option.isSome(property))
            context.report({ node, message: messageFor(property.value) });
        }
      },
    };
  },
});
