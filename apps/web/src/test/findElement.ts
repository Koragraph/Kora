import { isValidElement, type ReactElement } from "react";

type AnyElement = ReactElement<Record<string, unknown>>;

/** Every element in a rendered tree, depth first, looking inside every prop (slots and render props too). */
function* elementsIn(node: unknown): Generator<AnyElement> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elementsIn(child);
  } else if (isValidElement<Record<string, unknown>>(node)) {
    yield node;
    for (const prop of Object.values(node.props)) yield* elementsIn(prop);
  }
}

/**
 * The first element that `matches` in what a component returned when called as a plain function (see
 * ./hookStub.ts), or null.
 */
export function findElement(
  tree: unknown,
  matches: (element: AnyElement) => boolean,
): AnyElement | null {
  for (const element of elementsIn(tree)) if (matches(element)) return element;
  return null;
}
