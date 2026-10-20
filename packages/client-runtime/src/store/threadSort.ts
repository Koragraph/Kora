import type {
  ProjectId,
  NavThreadSortOrder,
  NavProjectSortOrder,
  ChatThreadHead,
} from "@kora/contracts";

export interface ThreadSortInput {
  readonly latestUserMessageAt?: string | null;
  readonly updatedAt: string;
  readonly createdAt: string;
  readonly messages?: ReadonlyArray<{ readonly createdAt: string; readonly role: string }>;
}

export const toSortableTimestamp = (iso: string | undefined): number | null => {
  const parsed = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(parsed) || !Number.isFinite(parsed) ? null : parsed;
};

export type SettledThreadTimestampInput = Pick<
  ChatThreadHead,
  "settledAt" | "latestUserMessageAt" | "latestTurn" | "updatedAt"
>;

const firstParseable = (...candidates: ReadonlyArray<string | null | undefined>): number | null => {
  for (const candidate of candidates) {
    const ms = toSortableTimestamp(candidate ?? undefined);
    if (ms !== null) return ms;
  }
  return null;
};

export function getThreadSortTimestamp(
  thread: ThreadSortInput,
  sortOrder: NavThreadSortOrder | Exclude<NavProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return firstParseable(thread.createdAt, thread.updatedAt) ?? Number.NEGATIVE_INFINITY;
  }
  const direct = toSortableTimestamp(thread.latestUserMessageAt ?? undefined);
  if (direct !== null) return direct;

  let newestUserMessage: number | null = null;
  for (const message of thread.messages ?? []) {
    if (message.role !== "user") continue;
    const ms = toSortableTimestamp(message.createdAt);
    if (ms !== null && (newestUserMessage === null || ms > newestUserMessage))
      newestUserMessage = ms;
  }
  if (newestUserMessage !== null) return newestUserMessage;
  return firstParseable(thread.updatedAt, thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

const compareNewestFirst = (
  a: { readonly id: string; readonly stamp: number },
  b: { readonly id: string; readonly stamp: number },
): number => {
  if (a.stamp !== b.stamp) return a.stamp > b.stamp ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id > b.id ? -1 : 1;
};

export function sortThreads<T extends { readonly id: string } & ThreadSortInput>(
  threads: readonly T[],
  sortOrder: NavThreadSortOrder,
): T[] {
  if (threads.length <= 1) return threads.slice();
  const keyed = threads.map((thread) => {
    const stamp = getThreadSortTimestamp(thread, sortOrder);
    return { stamp, id: thread.id, thread };
  });
  return keyed.toSorted(compareNewestFirst).map((entry) => entry.thread);
}

export function getLatestThreadForProject<
  T extends {
    readonly archivedAt: string | null;
    readonly projectId: ProjectId;
    readonly id: string;
  } & ThreadSortInput,
>(threads: readonly T[], projectId: ProjectId, sortOrder: NavThreadSortOrder): T | null {
  let best: { thread: T; id: string; stamp: number } | null = null;
  for (const thread of threads) {
    if (thread.projectId !== projectId || thread.archivedAt !== null) continue;
    const entry = { thread, id: thread.id, stamp: getThreadSortTimestamp(thread, sortOrder) };
    if (best === null || compareNewestFirst(entry, best) < 0) best = entry;
  }
  return best?.thread ?? null;
}

/** Later of creation and re-open, so a re-opened thread surfaces instead of sinking. */
const activeAnchor = (thread: {
  createdAt: string;
  unsettledAt?: string | null | undefined;
}): number => {
  const created = Date.parse(thread.createdAt);
  const reopened = thread.unsettledAt ? Date.parse(thread.unsettledAt) : 0;
  return Math.max(Number.isFinite(created) ? created : 0, Number.isFinite(reopened) ? reopened : 0);
};

// ---- Fractional "order keys" -------------------------------------------------------------
// Keys are strings over a..z read as base-26 fractions in (0,1). Plain string comparison orders
// them, and a key may never end in "a" (that would leave no room beneath it).

const RADIX = 26;
const CODE_A = "a".charCodeAt(0);
const digitOf = (ch: string | undefined): number =>
  ch === undefined ? 0 : ch.charCodeAt(0) - CODE_A;
const charOf = (digit: number): string => String.fromCharCode(CODE_A + digit);

const isValidKey = (key: string): boolean => /^[a-z]*[b-z]$/.test(key);

/** Midpoint of two fractions; `upper === ""` means "no upper bound". */
function midpoint(lower: string, upper: string): string {
  if (upper !== "" && lower >= upper) throw new Error("order keys out of sequence");

  // Shared leading digits carry over unchanged.
  if (upper !== "") {
    let shared = 0;
    while ((lower[shared] ?? "a") === upper[shared]) shared += 1;
    if (shared > 0)
      return upper.slice(0, shared) + midpoint(lower.slice(shared), upper.slice(shared));
  }

  const low = digitOf(lower[0]);
  const high = upper === "" ? RADIX : digitOf(upper[0]);
  if (high - low > 1) return charOf(Math.round((low + high) / 2));
  if (upper.length > 1) return upper[0]!;
  return charOf(low) + midpoint(lower.slice(1), "");
}

export function pinOrderKeyBetween(before: string | null, after: string | null): string | null {
  const [lower, upper] = [before ?? "", after ?? ""];
  // An empty bound is open; a present one must be well formed and in order.
  const bad = (key: string) => key.length > 0 && !isValidKey(key);
  if (bad(lower) || bad(upper)) return null;
  return upper.length > 0 && upper <= lower ? null : midpoint(lower, upper);
}

export function generateSpreadPinOrderKeys(count: number): string[] {
  if (count <= 0) return [];
  let width = 2;
  while (RADIX ** width <= (count + 1) * 2) width += 1;
  const space = RADIX ** width;
  const stride = space / (count + 1);
  const keys: string[] = [];
  for (let slot = 1; slot <= count; slot += 1) {
    let value = Math.round(stride * slot);
    if (value % RADIX === 0) value += 1;
    let rest = value;
    let key = "";
    for (let place = 0; place < width; place += 1) {
      key = charOf(rest % RADIX) + key;
      rest = Math.floor(rest / RADIX);
    }
    keys.push(key);
  }
  return keys;
}

type OrderedPin = { readonly id: string; readonly orderKey: string };

export function planPinnedReorder(input: {
  readonly movedId: string;
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly orderedIds: readonly string[];
}): ReadonlyArray<OrderedPin> {
  const { orderedIds, keysById, movedId } = input;
  const index = orderedIds.indexOf(movedId);
  if (index < 0) return [];

  const visible = new Set(orderedIds);
  const reserved = new Set<string>();
  for (const [id, key] of keysById) {
    if (!visible.has(id) && key) reserved.add(key);
  }

  const beforeId = orderedIds[index - 1];
  const afterId = orderedIds[index + 1];
  const beforeKey = beforeId === undefined ? null : (keysById.get(beforeId) ?? undefined);
  const afterKey = afterId === undefined ? null : (keysById.get(afterId) ?? undefined);

  if (beforeKey !== undefined && afterKey !== undefined) {
    let lower = beforeKey;
    let candidate = pinOrderKeyBetween(lower, afterKey);
    while (candidate !== null && reserved.has(candidate)) {
      lower = candidate;
      candidate = pinOrderKeyBetween(lower, afterKey);
    }
    if (candidate !== null) return [{ id: movedId, orderKey: candidate }];
  }

  // Can't squeeze in: lay the whole visible section out again, avoiding hidden rows' keys.
  const fresh = generateSpreadPinOrderKeys(orderedIds.length + reserved.size).filter(
    (key) => !reserved.has(key),
  );
  const assignments: Array<{ id: string; orderKey: string }> = [];
  orderedIds.forEach((id, position) => {
    const orderKey = fresh[position]!;
    if (keysById.get(id) !== orderKey) assignments.push({ id, orderKey });
  });
  return assignments;
}

const byIdentity = (
  a: { id: string; hostId?: string | undefined },
  b: { id: string; hostId?: string | undefined },
): number => a.id.localeCompare(b.id) || (a.hostId ?? "").localeCompare(b.hostId ?? "");

export function sortPinnedThreadsByOrderKey<
  T extends {
    id: string;
    createdAt: string;
    pinOrderKey?: string | null | undefined;
    hostId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  if (threads.length < 2) return [...threads];
  const created = (thread: T) => {
    const ms = Date.parse(thread.createdAt);
    return Number.isFinite(ms) ? ms : 0;
  };
  return threads.toSorted((a, b) => {
    const aKey = a.pinOrderKey ?? null;
    const bKey = b.pinOrderKey ?? null;
    if (aKey !== null && bKey !== null) {
      if (aKey !== bKey) return aKey < bKey ? -1 : 1;
      return byIdentity(a, b);
    }
    if (aKey !== null) return -1;
    if (bKey !== null) return 1;
    return created(b) - created(a) || byIdentity(a, b);
  });
}

export function sortActiveThreadsByOrderKey<
  T extends {
    id: string;
    createdAt: string;
    unsettledAt?: string | null | undefined;
    activeOrderKey?: string | null | undefined;
    hostId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  if (threads.length < 2) return [...threads];
  return threads.toSorted((a, b) => {
    const aKey = a.activeOrderKey ?? null;
    const bKey = b.activeOrderKey ?? null;
    if (aKey === null && bKey !== null) return -1;
    if (aKey !== null && bKey === null) return 1;
    if (aKey === null) {
      const diff = activeAnchor(b) - activeAnchor(a);
      return diff !== 0 ? diff : byIdentity(a, b);
    }
    if (aKey !== bKey) return aKey! < bKey! ? -1 : 1;
    return byIdentity(a, b);
  });
}
