import * as P from "effect/Predicate";

/** Optional all the way down; arrays keep their shape with partial elements. */
export type DeepPartial<T> = T extends object
  ? T extends readonly (infer Element)[]
    ? readonly DeepPartial<Element>[]
    : { [Key in keyof T]?: DeepPartial<T[Key]> }
  : T;

export function deepMerge<T extends Record<string, unknown>>(current: T, patch: DeepPartial<T>): T {
  if (!(P.isObject(current) && P.isObject(patch))) return patch as T;

  const result: Record<string, unknown> = Object.assign({}, current);
  Object.entries(patch)
    .filter(([, incoming]) => incoming !== undefined)
    .forEach(([name, incoming]) => {
      const base = result[name];
      result[name] =
        P.isObject(base) && P.isObject(incoming) ? deepMerge(base, incoming) : incoming;
    });
  return result as T;
}
