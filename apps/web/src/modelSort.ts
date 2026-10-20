import type { AgentProfileId } from "@kora/contracts";

export interface ModelSlugItem {
  readonly slug: string;
}

export interface AgentModelItem extends ModelSlugItem {
  readonly instanceId: AgentProfileId;
}

export const agentModelKey = (instanceId: AgentProfileId, slug: string): string =>
  `${instanceId}:${slug}`;

const asSet = (
  values: ReadonlySet<string> | ReadonlyArray<string> | undefined,
): ReadonlySet<string> => (values instanceof Set ? values : new Set(values ?? []));

/** Sorts by a list of numeric keys, earlier keys dominating; stable by construction. */
function sortByKeys<T>(items: ReadonlyArray<T>, keysOf: (item: T, index: number) => number[]): T[] {
  return items
    .map((item, index) => ({ item, keys: keysOf(item, index) }))
    .sort((a, b) => {
      for (let i = 0; i < a.keys.length; i++) {
        const diff = a.keys[i]! - b.keys[i]!;
        if (diff !== 0 && !Number.isNaN(diff)) return diff;
      }
      return 0;
    })
    .map((entry) => entry.item);
}

const rankIn = (order: ReadonlyArray<string>) => {
  const rank = new Map<string, number>();
  order.forEach((value, index) => rank.set(value, index));
  return (value: string) => rank.get(value) ?? Number.POSITIVE_INFINITY;
};

export function sortModelsForAgentProfile<T extends ModelSlugItem>(
  models: ReadonlyArray<T>,
  options?: {
    modelOrder?: ReadonlyArray<string>;
    favoriteModels?: ReadonlySet<string> | ReadonlyArray<string>;
    groupFavorites?: boolean;
  },
): T[] {
  const favorites = asSet(options?.favoriteModels);
  const rank = rankIn(options?.modelOrder ?? []);
  return sortByKeys(models, (model, index) => [
    options?.groupFavorites === true && favorites.has(model.slug) ? 0 : 1,
    rank(model.slug),
    index,
  ]);
}

export function sortAgentModelItems<T extends AgentModelItem>(
  items: ReadonlyArray<T>,
  options?: {
    favoriteModelKeys?: ReadonlySet<string> | ReadonlyArray<string>;
    groupFavorites?: boolean;
    instanceOrder?: ReadonlyArray<AgentProfileId>;
  },
): T[] {
  const favorites = asSet(options?.favoriteModelKeys);
  const instanceRank = rankIn(options?.instanceOrder ?? []);
  // Later duplicates of a key overwrite the recorded position.
  const position = new Map<string, number>();
  items.forEach((item, index) => position.set(agentModelKey(item.instanceId, item.slug), index));
  return sortByKeys(items, (item) => {
    const key = agentModelKey(item.instanceId, item.slug);
    return [
      options?.groupFavorites === true && favorites.has(key) ? 0 : 1,
      instanceRank(item.instanceId),
      position.get(key)!,
    ];
  });
}
