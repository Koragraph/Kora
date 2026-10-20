import { cn, thisComputer } from "~/util/utils";
import { fixSegments } from "~/util/healthCheck";
import { useUpdateClientPrefs, useClientPrefs } from "~/hooks/usePrefs";
import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";
import {
  parseModelPickerLegacySectionKey,
  modelPickerLegacySectionKey,
  parseModelPickerModelKey,
  modelPickerModelKey,
} from "./modelPickerKeys";
import type { ModelEsque } from "./agentIconUtils";
import { ModelPickerAgentTabs } from "./ModelPickerAgentTabs";
import { ModelListRow } from "./ModelListRow";
import { getAgentStatusMessage, hasAgentSetup } from "./AgentStatusBanner";
import { ComboboxListVirtualized, ComboboxInput, ComboboxItem, Combobox } from "../ui/combobox";
import { Button } from "../ui/button";
import { sortAgentModelItems, agentModelKey } from "../../modelSort";
import {
  isAgentProfilePickerVisible,
  isAgentProfilePickerReady,
  type AgentProfileEntry,
} from "../../agentProfiles";
import { resolveSelectableModel } from "@kora/shared/modelOptions";
import { ANTIGRAVITY_DEFAULT_MODEL, type AgentProfileId, type AgentId } from "@kora/contracts";
import {
  useLayoutEffect,
  useCallback,
  useEffect,
  Fragment,
  useState,
  useMemo,
  useRef,
  memo,
} from "react";
import { ChevronRightIcon, SearchIcon } from "lucide-react";
import { type LegendListRef, LegendList } from "@legendapp/list/react";

type Tab = AgentProfileId | "favorites";

// ---------------------------------------------------------------------------
// Pure helpers

export function resolveModelPickerSelectedModel(input: {
  driverKind: AgentId | undefined;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}): ModelEsque | undefined {
  const { driverKind, model, options } = input;
  if (driverKind === "antigravity" && model === ANTIGRAVITY_DEFAULT_MODEL) {
    const usable = options.filter(
      (option) => !option.isUnavailable && option.slug !== ANTIGRAVITY_DEFAULT_MODEL,
    );
    return (
      usable.find((option) => option.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL)) ??
      options.find((option) => !option.isUnavailable && option.isDefault)
    );
  }
  return options.find((option) => option.slug === model);
}

export function shouldIncludeModelPickerOption(input: {
  entry: AgentProfileEntry;
  option: ModelEsque;
  activeInstanceId: AgentProfileId;
  activeModel: string;
}): boolean {
  const { entry, option, activeInstanceId, activeModel } = input;
  if (option.slug === ANTIGRAVITY_DEFAULT_MODEL) return false;
  if (isAgentProfilePickerReady(entry)) return true;
  return (
    entry.enabled &&
    (entry.driverKind === "opencode" || entry.driverKind === "antigravity") &&
    entry.instanceId === activeInstanceId &&
    option.slug === activeModel &&
    option.isUnavailable === true
  );
}

export function shouldOfferModelPickerSetup(
  entry: AgentProfileEntry,
  options: ReadonlyArray<ModelEsque>,
): boolean {
  if (!entry.enabled || entry.status === "disabled") return false;
  if (!hasAgentSetup(entry.snapshot)) return false;
  return (
    !isAgentProfilePickerReady(entry) ||
    !entry.installed ||
    entry.snapshot.auth.status === "unauthenticated" ||
    !options.some((option) => !option.isUnavailable)
  );
}

export function agentUnusableReason(entry: AgentProfileEntry | undefined): string | null {
  if (!entry || !entry.enabled || entry.status === "disabled") return null;
  // Chat runs on Kora's bundled Claude; a signed-out turn explains itself.
  if (entry.driverKind === "claude") return null;
  const name = entry.displayName.trim() || entry.driverKind;
  if (!entry.installed) {
    return entry.driverKind === "antigravity"
      ? `Antigravity isn't installed on ${thisComputer()}. Install it (the \`agy\` command), then press Re-check in Settings → Engines.`
      : `${name} isn't installed on ${thisComputer()}. Settings → Agents says how to add it.`;
  }
  if (entry.snapshot.auth.status === "unauthenticated") {
    return entry.driverKind === "codex"
      ? "Codex isn't signed in. In Terminal, run `codex login`, then come back to Kora."
      : entry.driverKind === "antigravity"
        ? "Antigravity isn't signed in. In Terminal, run `agy` once and sign in, then come back to Kora."
        : `${name} isn't signed in. Settings → Agents says how to sign in.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// List model

type PickerItem = {
  key: string;
  slug: string;
  model: ModelEsque;
  instanceId: AgentProfileId;
  driverKind: AgentId;
  providerDisplayName: string;
  accentColor: string | undefined;
  continuationGroupKey: string | undefined;
  isLegacy: boolean;
  unavailable: boolean;
};

type Row =
  | { kind: "model"; key: string; item: PickerItem }
  | { kind: "legacy"; key: string; instanceId: AgentProfileId; count: number };

const FADE_PX = 1;
const FADE_MASK = {
  both: "[mask-image:linear-gradient(to_bottom,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]",
  top: "[mask-image:linear-gradient(to_bottom,transparent,black_1.5rem)]",
  bottom: "[mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]",
} as const;

type Props = {
  activeInstanceId: AgentProfileId;
  model: string;
  lockedProvider: AgentId | null;
  lockedContinuationGroupKey?: string | null;
  instanceEntries: ReadonlyArray<AgentProfileEntry>;
  modelOptionsByInstance: ReadonlyMap<AgentProfileId, ReadonlyArray<ModelEsque>>;
  onRequestClose?: () => void;
  onOpenProviderSetup?: (instanceId: AgentProfileId) => void;
  whyModelDisabled?: (instanceId: AgentProfileId, model: string) => string | null;
  onInstanceModelChange: (instanceId: AgentProfileId, model: string) => void;
};

function Note({ text }: { text: string }) {
  return (
    <>
      {fixSegments(text).map((segment, index) =>
        segment.code ? (
          <code
            className="rounded bg-muted px-1 py-px font-mono text-[11px] text-foreground"
            key={index}
          >
            {segment.text}
          </code>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

export const ModelPickerContent = memo(function ModelPickerContent({
  activeInstanceId,
  model,
  lockedProvider,
  lockedContinuationGroupKey,
  instanceEntries,
  modelOptionsByInstance,
  onRequestClose,
  onOpenProviderSetup,
  whyModelDisabled,
  onInstanceModelChange,
}: Props) {
  const favoritesPref = useClientPrefs((prefs) => prefs.favorites);
  const updateClientPrefs = useUpdateClientPrefs();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<LegendListRef | null>(null);

  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;

  const entryById = useMemo(
    () => new Map(instanceEntries.map((entry) => [entry.instanceId, entry] as const)),
    [instanceEntries],
  );
  const instanceOrder = useMemo(
    () => instanceEntries.map(({ instanceId }) => instanceId),
    [instanceEntries],
  );

  const matchesLock = useCallback(
    (entry: { driverKind: AgentId; continuationGroupKey?: string | undefined }) =>
      !lockedProvider ||
      (entry.driverKind === lockedProvider &&
        (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey)),
    [lockedProvider, lockedContinuationGroupKey],
  );

  // ---- flatten every instance's models ----
  const allItems = useMemo(() => {
    const items: PickerItem[] = [];
    for (const [instanceId, options] of modelOptionsByInstance) {
      const entry = entryById.get(instanceId);
      if (!entry) continue; // stale instance
      for (const option of options) {
        if (
          !shouldIncludeModelPickerOption({
            entry,
            option,
            activeInstanceId,
            activeModel: model,
          })
        ) {
          continue;
        }
        items.push({
          key: modelPickerModelKey(instanceId, option.slug),
          slug: option.slug,
          model: option,
          instanceId,
          driverKind: entry.driverKind,
          providerDisplayName: entry.displayName,
          accentColor: entry.accentColor,
          continuationGroupKey: entry.continuationGroupKey,
          isLegacy: option.isLegacy === true,
          unavailable: option.isUnavailable === true,
        });
      }
    }
    return items;
  }, [modelOptionsByInstance, entryById, activeInstanceId, model]);

  // ---- favourites ----
  const favoriteKeys = useMemo(
    () =>
      new Set(
        (favoritesPref ?? []).map((favorite) => agentModelKey(favorite.provider, favorite.model)),
      ),
    [favoritesPref],
  );
  const hasFavorites = allItems.some((item) =>
    favoriteKeys.has(agentModelKey(item.instanceId, item.slug)),
  );

  const toggleFavorite = useCallback(
    (item: PickerItem) => {
      const current = favoritesPref ?? [];
      const exists = current.some(
        (favorite) => favorite.provider === item.instanceId && favorite.model === item.slug,
      );
      updateClientPrefs({
        favorites: exists
          ? current.filter(
              (favorite) =>
                !(favorite.provider === item.instanceId && favorite.model === item.slug),
            )
          : [...current, { provider: item.instanceId, model: item.slug }],
      });
    },
    [favoritesPref, updateClientPrefs],
  );

  // ---- tabs ----
  const activeEntry = entryById.get(activeInstanceId);
  const activeOptions = modelOptionsByInstance.get(activeInstanceId) ?? [];
  const activeHasSelectableUnavailable =
    !!activeEntry &&
    !isAgentProfilePickerReady(activeEntry) &&
    allItems.some((item) => item.instanceId === activeInstanceId);
  const activeNeedsSetup = !!activeEntry && shouldOfferModelPickerSetup(activeEntry, activeOptions);

  const [selectedTab, setSelectedTab] = useState<Tab>(() =>
    lockedProvider || activeHasSelectableUnavailable || activeNeedsSetup
      ? activeInstanceId
      : hasFavorites
        ? "favorites"
        : activeInstanceId,
  );

  const [legacyExpanded, setLegacyExpanded] = useState(() =>
    activeOptions.some((option) => option.slug === model && option.isLegacy === true),
  );

  const visibleEntries = useMemo(() => {
    const visible = instanceEntries.filter(isAgentProfilePickerVisible);
    if (!lockedProvider) return visible;
    return [...visible.filter(matchesLock), ...visible.filter((entry) => !matchesLock(entry))];
  }, [instanceEntries, lockedProvider, matchesLock]);

  const showTabs = !searching && visibleEntries.length > 0;

  const disabledInstanceIds = useMemo(
    () =>
      lockedProvider
        ? new Set(visibleEntries.filter((entry) => !matchesLock(entry)).map((e) => e.instanceId))
        : undefined,
    [lockedProvider, visibleEntries, matchesLock],
  );

  const setupEntries = useMemo(
    () =>
      instanceEntries.filter(
        (entry) =>
          matchesLock(entry) &&
          shouldOfferModelPickerSetup(entry, modelOptionsByInstance.get(entry.instanceId) ?? []),
      ),
    [instanceEntries, matchesLock, modelOptionsByInstance],
  );

  const selectableUnavailableInstanceIds = useMemo(() => {
    const ids = new Set<AgentProfileId>(setupEntries.map((entry) => entry.instanceId));
    if (activeHasSelectableUnavailable) ids.add(activeInstanceId);
    return ids;
  }, [setupEntries, activeHasSelectableUnavailable, activeInstanceId]);

  // ---- rows ----
  const rows = useMemo<Row[]>(() => {
    const isFavorite = (item: PickerItem) =>
      favoriteKeys.has(agentModelKey(item.instanceId, item.slug));
    let pool: PickerItem[];

    if (searching) {
      pool = allItems
        .filter((item) => matchesLock(item))
        .map((item) => ({
          item,
          score: scoreModelPickerSearch(
            {
              driverKind: item.driverKind,
              providerDisplayName: item.providerDisplayName,
              name: item.model.name,
              ...(item.model.shortName ? { shortName: item.model.shortName } : {}),
              ...(item.model.subProvider ? { subProvider: item.model.subProvider } : {}),
              isFavorite: isFavorite(item),
            },
            query,
          ),
        }))
        .filter((entry): entry is { item: PickerItem; score: number } => entry.score !== null)
        .toSorted((a, b) => {
          if (a.score !== b.score) return a.score - b.score;
          const favoriteDiff = Number(isFavorite(b.item)) - Number(isFavorite(a.item));
          if (favoriteDiff !== 0) return favoriteDiff;
          return buildModelPickerSearchText({
            driverKind: a.item.driverKind,
            providerDisplayName: a.item.providerDisplayName,
            name: a.item.model.name,
          }).localeCompare(
            buildModelPickerSearchText({
              driverKind: b.item.driverKind,
              providerDisplayName: b.item.providerDisplayName,
              name: b.item.model.name,
            }),
          );
        })
        .map((entry) => entry.item);
      return pool.map((item) => ({ kind: "model", key: item.key, item }));
    }

    pool = allItems.filter((item) => matchesLock(item));
    pool =
      selectedTab === "favorites"
        ? pool.filter(isFavorite)
        : pool.filter((item) => item.instanceId === selectedTab);
    const sorted = sortAgentModelItems(pool, {
      favoriteModelKeys: favoriteKeys,
      groupFavorites: selectedTab !== "favorites",
      instanceOrder,
    });

    if (selectedTab === "favorites") {
      return sorted.map((item) => ({ kind: "model", key: item.key, item }));
    }
    const current = sorted.filter((item) => !item.isLegacy);
    const legacy = sorted.filter((item) => item.isLegacy);
    const result: Row[] = current.map((item) => ({ kind: "model", key: item.key, item }));
    if (legacy.length > 0) {
      result.push({
        kind: "legacy",
        key: modelPickerLegacySectionKey(selectedTab),
        instanceId: selectedTab,
        count: legacy.length,
      });
      if (legacyExpanded) {
        for (const item of legacy) result.push({ kind: "model", key: item.key, item });
      }
    }
    return result;
  }, [
    allItems,
    favoriteKeys,
    instanceOrder,
    legacyExpanded,
    matchesLock,
    query,
    searching,
    selectedTab,
  ]);

  const rowKeys = useMemo(() => rows.map((row) => row.key), [rows]);
  const rowIndexByKey = useMemo(
    () => new Map(rowKeys.map((key, index) => [key, index] as const)),
    [rowKeys],
  );

  // ---- selecting ----
  const selectModel = useCallback(
    (instanceId: AgentProfileId, slug: string) => {
      const entry = entryById.get(instanceId);
      if (agentUnusableReason(entry) !== null) return;
      if (whyModelDisabled?.(instanceId, slug)) return;
      const options = modelOptionsByInstance.get(instanceId) ?? [];
      const driverKind = entry?.driverKind;
      const resolved = driverKind ? resolveSelectableModel(driverKind, slug, options) : null;
      onInstanceModelChange(instanceId, resolved ?? slug);
    },
    [entryById, whyModelDisabled, modelOptionsByInstance, onInstanceModelChange],
  );

  const onValueChange = useCallback(
    (key: string | null) => {
      if (!key) return;
      if (parseModelPickerLegacySectionKey(key)) {
        setLegacyExpanded((value) => !value);
        return;
      }
      const parsed = parseModelPickerModelKey(key);
      if (parsed) selectModel(parsed.instanceId, parsed.slug);
    },
    [selectModel],
  );

  const selectedValue = useMemo(() => {
    const resolved = resolveModelPickerSelectedModel({
      driverKind: activeEntry?.driverKind,
      model,
      options: activeOptions,
    });
    return modelPickerModelKey(activeInstanceId, resolved?.slug ?? model);
  }, [activeEntry, activeInstanceId, activeOptions, model]);

  // ---- focus ----
  useLayoutEffect(() => {
    searchRef.current?.focus();
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    const timer = setTimeout(() => searchRef.current?.focus(), 0);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, []);

  const chooseTab = useCallback((tab: Tab) => {
    setSelectedTab(tab);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  // ---- scroll fades ----
  const [fades, setFades] = useState({ top: false, bottom: false });
  useEffect(() => {
    setFades({ top: false, bottom: rows.length > 5 });
  }, [rows.length, selectedTab, searching]);

  const onListScroll = useCallback(
    (event: {
      nativeEvent: {
        contentOffset: { y: number };
        contentSize: { height: number };
        layoutMeasurement: { height: number };
      };
    }) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const top = contentOffset.y > FADE_PX;
      const bottom = contentSize.height - (contentOffset.y + layoutMeasurement.height) > FADE_PX;
      setFades((previous) =>
        previous.top === top && previous.bottom === bottom ? previous : { top, bottom },
      );
    },
    [],
  );

  const fadeClass =
    fades.top && fades.bottom
      ? FADE_MASK.both
      : fades.top
        ? FADE_MASK.top
        : fades.bottom
          ? FADE_MASK.bottom
          : undefined;

  // ---- notes & setup prompts ----
  const selectedEntry = selectedTab === "favorites" ? undefined : entryById.get(selectedTab);
  const unusableNote = agentUnusableReason(selectedEntry);
  const setupPrompts =
    !searching && onOpenProviderSetup
      ? setupEntries.filter((entry) =>
          selectedTab === "favorites" ? rows.length === 0 : entry.instanceId === selectedTab,
        )
      : [];
  // Setup opens in its own surface, so the picker closes first.
  const openSetupFor = (instanceId: AgentProfileId) => {
    onRequestClose?.();
    onOpenProviderSetup?.(instanceId);
  };

  return (
    <div
      className="relative flex h-screen max-h-[26rem] min-h-0 w-[calc(100vw-1rem)] max-w-[23rem] flex-col overflow-hidden"
      data-model-picker-content="true"
    >
      {showTabs ? (
        <ModelPickerAgentTabs
          {...(disabledInstanceIds ? { disabledInstanceIds } : {})}
          getDisabledInstanceTooltip={(entry) =>
            `${entry.displayName} is unavailable in this thread. Start a new thread to switch providers.`
          }
          instanceEntries={visibleEntries}
          onSelectInstance={chooseTab}
          selectableUnavailableInstanceIds={selectableUnavailableInstanceIds}
          selectedInstanceId={selectedTab}
          showFavorites
        />
      ) : null}
      <Combobox
        autoHighlight
        filter={null}
        inline
        inputValue={query}
        items={rowKeys}
        onInputValueChange={(value) => setQuery(value)}
        onItemHighlighted={(value, details) => {
          if (details.reason !== "keyboard" || typeof value !== "string") return;
          const index = rowIndexByKey.get(value);
          if (index !== undefined) {
            void listRef.current?.scrollIndexIntoView({ index, animated: false });
          }
        }}
        onValueChange={onValueChange}
        open
        value={selectedValue}
        virtualized
      >
        <div
          className={cn("flex min-h-0 flex-1 flex-col", showTabs && "border-border/60 border-t")}
        >
          <div className="px-2.5 pt-2.5 pb-1.5">
            <div
              className="flex items-center rounded-[var(--control-radius)] border border-border/60 bg-muted/40 px-2.5 transition-colors focus-within:border-ring"
              onMouseDown={(event) => event.stopPropagation()}
              onTouchStart={(event) => event.stopPropagation()}
            >
              <SearchIcon
                aria-hidden="true"
                className="-ms-0.5 me-2 size-4 shrink-0 text-muted-foreground/70"
              />
              <ComboboxInput
                aria-label="Find a model"
                className="min-w-0 flex-1"
                inputClassName="*:data-[slot=input]:h-8 *:data-[slot=input]:rounded-none *:data-[slot=input]:bg-transparent *:data-[slot=input]:px-0 *:data-[slot=input]:font-sans *:data-[slot=input]:text-sm *:data-[slot=input]:leading-8 sm:*:data-[slot=input]:h-8 sm:*:data-[slot=input]:leading-8"
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Escape") {
                    event.preventDefault();
                    onRequestClose?.();
                  }
                }}
                placeholder="Find a model"
                ref={searchRef}
                showTrigger={false}
                unstyled
              />
            </div>
          </div>
          {unusableNote ? (
            <p
              className="mx-2 mt-1.5 rounded-md bg-foreground/5 px-2.5 py-1.5 text-muted-foreground text-xs leading-snug"
              data-model-picker-agent-unusable=""
            >
              <Note text={unusableNote} />
            </p>
          ) : null}
          <div className="relative min-h-0 flex-1 overflow-hidden pr-px">
            {rows.length === 0 && setupPrompts.length === 0 ? (
              <p className="py-6 text-center text-muted-foreground text-xs leading-snug">
                No model by that name
              </p>
            ) : null}
            {rows.length > 0 ? (
              <ComboboxListVirtualized className="h-full p-0">
                <LegendList
                  className={cn("h-full", fadeClass)}
                  contentContainerStyle={{ paddingLeft: 8, paddingRight: 1, paddingBlock: 6 }}
                  data={rows}
                  drawDistance={480}
                  estimatedItemSize={30}
                  ItemSeparatorComponent={() => <div style={{ height: 1 }} />}
                  keyExtractor={(row) => row.key}
                  onScroll={onListScroll}
                  recycleItems
                  ref={listRef}
                  renderItem={({ item: row, index }) =>
                    row.kind === "legacy" ? (
                      <LegacyHeader
                        count={row.count}
                        expanded={legacyExpanded}
                        index={index}
                        value={row.key}
                      />
                    ) : (
                      <ModelListRow
                        disabledReason={
                          agentUnusableReason(entryById.get(row.item.instanceId)) ??
                          whyModelDisabled?.(row.item.instanceId, row.item.slug) ??
                          null
                        }
                        driverKind={row.item.driverKind}
                        index={index}
                        instanceId={row.item.instanceId}
                        isFavorite={favoriteKeys.has(
                          agentModelKey(row.item.instanceId, row.item.slug),
                        )}
                        isSelected={row.key === selectedValue}
                        model={row.item.model}
                        onToggleFavorite={() => toggleFavorite(row.item)}
                        providerDisplayName={row.item.providerDisplayName}
                        showNewBadge={row.item.model.badge === "new"}
                        showProvider={query.trim() !== "" || selectedTab === "favorites"}
                        unavailable={row.item.unavailable}
                        {...(row.item.accentColor
                          ? { providerAccentColor: row.item.accentColor }
                          : {})}
                      />
                    )
                  }
                  style={{
                    scrollbarGutter: "stable",
                    overflowX: "hidden",
                    overscrollBehavior: "contain",
                  }}
                />
              </ComboboxListVirtualized>
            ) : null}
          </div>
          {setupPrompts.length > 0 ? (
            <div className="max-h-44 shrink-0 overflow-y-auto border-border/70 border-t p-2">
              {setupPrompts.map((entry) => (
                <div className="px-1.5 py-1 text-xs leading-snug" key={entry.instanceId}>
                  <p className="line-clamp-3 text-muted-foreground">
                    {getAgentStatusMessage(entry.snapshot)}
                  </p>
                  <Button
                    className="mt-1 px-0 text-foreground"
                    onClick={() => openSetupFor(entry.instanceId)}
                    size="xs"
                    variant="link"
                  >
                    {setupPrompts.length > 1 ? `Set up ${entry.displayName}` : "Open agent setup"}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Combobox>
    </div>
  );
});

function LegacyHeader({
  count,
  expanded,
  index,
  value,
}: {
  count: number;
  expanded: boolean;
  index: number;
  value: string;
}) {
  return (
    <ComboboxItem
      className="w-full cursor-pointer rounded-md p-2 data-selected:bg-transparent"
      contentClassName="flex items-center gap-3"
      hideIndicator
      index={index}
      value={value}
    >
      <span className="font-medium text-xs">Older models</span>
      <span className="text-muted-foreground/70 text-xs">{`${count} models`}</span>
      <ChevronRightIcon
        className={cn(
          "ms-auto size-4 text-muted-foreground transition-transform",
          expanded && "rotate-90",
        )}
      />
    </ComboboxItem>
  );
}
