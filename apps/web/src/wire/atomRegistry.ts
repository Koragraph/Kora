import { createElement } from "react";
import { AtomRegistry } from "effect/unstable/reactivity";
import { RegistryContext } from "@effect/atom-react";

export const koraAtomRegistry = AtomRegistry.make();

export function AppAtomRegistryProvider(props: React.PropsWithChildren) {
  return createElement(RegistryContext.Provider, { value: koraAtomRegistry }, props.children);
}
