import { CustomModelEditor } from "./CustomModelEditor";
import { TooltipTrigger, TooltipPopup, Tooltip } from "../ui/tooltip";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Button } from "../ui/button";
import { cn } from "../../util/utils";
import { MAX_CUSTOM_MODEL_LENGTH } from "../../modelPick";
import { sortModelsForAgentProfile } from "../../modelSort";
import { canonicalCustomModelSlug, type CustomModelDefinition } from "@kora/shared/modelOptions";
import type { AgentProfileId, AgentModel, AgentId } from "@kora/contracts";
import { type ReactNode, useEffect, useState, useMemo, useRef } from "react";
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, StarIcon, XIcon } from "lucide-react";

type ModelGroup = "favorite" | "visible" | "hidden";

/** Favorites first, then the visible models, then the ones hidden from the picker; each in the user's order. */
export function groupModelsForDisplay<
  T extends { readonly isCustom: boolean; readonly slug: string },
>(
  models: ReadonlyArray<T>,
  options: {
    favoriteModels: ReadonlySet<string>;
    hiddenModels: ReadonlySet<string>;
    modelOrder: ReadonlyArray<string>;
  },
): T[] {
  const ordered = sortModelsForAgentProfile(models, {
    favoriteModels: options.favoriteModels,
    modelOrder: options.modelOrder,
    groupFavorites: true,
  });
  const isHidden = (model: T) => !model.isCustom && options.hiddenModels.has(model.slug);
  const favorites = ordered.filter((model) => options.favoriteModels.has(model.slug));
  const rest = ordered.filter((model) => !options.favoriteModels.has(model.slug));
  return [...favorites, ...rest.filter((model) => !isHidden(model)), ...rest.filter(isHidden)];
}

export function nextHiddenModelsForBulkToggle(
  models: ReadonlyArray<Pick<AgentModel, "slug" | "isCustom">>,
  hiddenModels: ReadonlyArray<string>,
): string[] {
  const builtIn = models.filter((model) => !model.isCustom).map((model) => model.slug);
  const hidden = new Set(hiddenModels);
  if (builtIn.every((slug) => hidden.has(slug))) {
    const shown = new Set(builtIn);
    return hiddenModels.filter((slug) => !shown.has(slug));
  }
  return [...new Set([...hiddenModels, ...builtIn])];
}

const PLACEHOLDER_BY_DRIVER: Record<string, string> = {
  codex: "gpt-6.7-codex-ultra-preview",
  claude: "claude-sonnet-5",
  cursor: "claude-sonnet-4-6",
  opencode: "openai/gpt-5",
};

function capabilityChips(model: AgentModel): string[] {
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  type Descriptor = (typeof descriptors)[number];
  const isFastTier = (descriptor: Descriptor) =>
    descriptor.id === "serviceTier" &&
    descriptor.type === "select" &&
    descriptor.options.some((option) => option.id === "fast" || option.label === "Fast");
  const isReasoningSelect = (descriptor: Descriptor) =>
    descriptor.type === "select" &&
    ["reasoningEffort", "effort", "reasoning", "variant"].includes(descriptor.id);

  const chips: string[] = [];
  if (descriptors.some((descriptor) => descriptor.id === "fastMode" || isFastTier(descriptor))) {
    chips.push("Fast mode");
  }
  if (descriptors.some((descriptor) => descriptor.id === "thinking")) {
    chips.push("Thinking");
  }
  if (descriptors.some(isReasoningSelect)) {
    chips.push("Reasoning");
  }
  return chips;
}

const chipClass = "rounded-sm border border-border/70 px-1 text-[10px] text-muted-foreground";

function Hinted(props: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{props.children}</TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function AgentModelsSection(props: {
  instanceId: AgentProfileId;
  driverKind: AgentId | null;
  models: ReadonlyArray<AgentModel>;
  customModels: ReadonlyArray<CustomModelDefinition>;
  hiddenModels: ReadonlyArray<string>;
  favoriteModels: ReadonlyArray<string>;
  modelOrder: ReadonlyArray<string>;
  onChange: (next: ReadonlyArray<CustomModelDefinition>) => void;
  onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  onModelOrderChange: (next: ReadonlyArray<string>) => void;
}) {
  const {
    onFavoriteModelsChange,
    onHiddenModelsChange,
    onModelOrderChange,
    favoriteModels,
    hiddenModels,
    customModels,
    modelOrder,
    instanceId,
    driverKind,
    onChange,
    models,
  } = props;

  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [draftSlug, setDraftSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const scrollToSlug = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const favoriteSet = useMemo(() => new Set(favoriteModels), [favoriteModels]);
  const hiddenSet = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const displayed = useMemo(
    () =>
      groupModelsForDisplay(models, {
        favoriteModels: favoriteSet,
        hiddenModels: hiddenSet,
        modelOrder,
      }),
    [models, favoriteSet, hiddenSet, modelOrder],
  );

  const showFilter = models.length > 8;
  const needle = showFilter ? filter.trim().toLowerCase() : "";
  const filtering = needle !== "";
  const visible = filtering
    ? displayed.filter(
        (model) =>
          model.name.toLowerCase().includes(needle) || model.slug.toLowerCase().includes(needle),
      )
    : displayed;

  const groupOf = (model: AgentModel): ModelGroup =>
    favoriteSet.has(model.slug)
      ? "favorite"
      : !model.isCustom && hiddenSet.has(model.slug)
        ? "hidden"
        : "visible";

  const favoriteCount = displayed.filter((model) => favoriteSet.has(model.slug)).length;
  const hiddenCount = displayed.filter(
    (model) => !model.isCustom && hiddenSet.has(model.slug),
  ).length;
  const builtIn = models.filter((model) => !model.isCustom);
  const allBuiltInHidden = builtIn.every((model) => hiddenSet.has(model.slug));

  // Bring a freshly added model into view once the parent has rendered its row.
  useEffect(() => {
    const slug = scrollToSlug.current;
    if (!slug) return;
    const row = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-model-slug]") ?? [],
    ).find((element) => element.dataset.modelSlug === slug);
    if (!row) return;
    scrollToSlug.current = null;
    row.scrollIntoView({ block: "nearest" });
  });

  const move = (slug: string, direction: -1 | 1) => {
    const index = displayed.findIndex((model) => model.slug === slug);
    const neighbour = displayed[index + direction];
    if (index < 0 || !neighbour || groupOf(neighbour) !== groupOf(displayed[index]!)) return;
    const order = displayed.map((model) => model.slug);
    [order[index], order[index + direction]] = [order[index + direction]!, order[index]!];
    onModelOrderChange(order);
  };

  const removeCustom = (slug: string) => {
    if (editingSlug === slug) setEditingSlug(null);
    onChange(customModels.filter((entry) => entry.slug !== slug));
    onModelOrderChange(modelOrder.filter((existing) => existing !== slug));
    onFavoriteModelsChange(favoriteModels.filter((existing) => existing !== slug));
    setError(null);
  };

  const submitCustom = () => {
    const slug = canonicalCustomModelSlug(draftSlug);
    let problem: string | null = null;
    if (!slug) problem = "Enter a model slug.";
    else if (models.some((model) => !model.isCustom && model.slug === slug))
      problem = "That model is already built in.";
    else if (slug.length > MAX_CUSTOM_MODEL_LENGTH) {
      problem = `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`;
    } else if (customModels.some((entry) => entry.slug === slug))
      problem = "That custom model is already saved.";
    if (problem || !slug) {
      setError(problem);
      return;
    }
    setFilter("");
    scrollToSlug.current = slug;
    onChange([...customModels, { slug, name: slug, capabilities: null }]);
    setDraftSlug("");
    setError(null);
    setAdding(false);
  };

  let previousGroup: ModelGroup | null = null;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const divBlock =
    adding && driverKind !== "antigravity" ? (
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          onChange={(event) => {
            setDraftSlug(event.target.value);
            setError(null);
          }}
          size="sm"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submitCustom();
              event.preventDefault();
            } else if (event.key === "Escape") {
              setAdding(false);
              setError(null);
            }
          }}
          autoFocus
          spellCheck={false}
          id={`provider-instance-${instanceId}-custom-model`}
          placeholder={PLACEHOLDER_BY_DRIVER[driverKind ?? ""] ?? "model-slug"}
          value={draftSlug}
        />
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={submitCustom}>
            Add
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setAdding(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    ) : null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {showFilter ? (
          <Input
            size="sm"
            className="w-56 max-w-full"
            spellCheck={false}
            placeholder="Filter models"
            aria-label="Filter models"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        ) : null}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {plural(models.length, "model")}
            {favoriteCount > 0 ? ` · ${plural(favoriteCount, "favorite")}` : ""}
            {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
          </span>
          {builtIn.length > 0 ? (
            <Button
              onClick={() =>
                onHiddenModelsChange(nextHiddenModelsForBulkToggle(models, hiddenModels))
              }
              variant="ghost-muted"
              size="xs"
            >
              {allBuiltInHidden ? "Show all in picker" : "Hide all from picker"}
            </Button>
          ) : null}
        </div>
        {driverKind !== "antigravity" ? (
          <Button
            variant="ghost-muted"
            size="xs"
            className="ml-auto"
            onClick={() => setAdding(true)}
          >
            <PlusIcon className="size-3" />
            Add custom model
          </Button>
        ) : null}
      </div>

      <div
        className="mt-2 max-h-72 overflow-y-auto rounded-md ring-1 ring-black/5 dark:ring-white/5"
        ref={listRef}
      >
        {visible.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {filtering ? "No models match." : "No models reported for this provider yet."}
          </p>
        ) : null}
        {visible.map((model, index) => {
          const group = groupOf(model);
          const startsGroup = group !== previousGroup;
          previousGroup = group;
          const label = !startsGroup
            ? null
            : group === "favorite"
              ? "Favorites"
              : group === "hidden"
                ? "Hidden from picker"
                : favoriteCount > 0
                  ? "All"
                  : null;
          const hidden = group === "hidden";
          const favorite = favoriteSet.has(model.slug);
          const isLast = index === visible.length - 1;
          const displayIndex = displayed.findIndex((entry) => entry.slug === model.slug);
          const canMove = (direction: -1 | 1) => {
            const neighbour = displayed[displayIndex + direction];
            return !!neighbour && groupOf(neighbour) === group;
          };
          const entry = customModels.find((candidate) => candidate.slug === model.slug);
          let checkboxTip = "Shown in picker";
          if (hidden) checkboxTip = "Hidden from picker";
          if (model.isCustom) checkboxTip = "Custom models are always shown in the picker";
          return (
            <div key={`${instanceId}:${model.slug}`}>
              {label ? (
                <div
                  className={cn(
                    "border-b border-border/40 bg-muted/40 px-2 py-1 text-[10.5px] font-medium tracking-wider text-muted-foreground uppercase",
                    index > 0 && "border-t",
                  )}
                >
                  {label}
                </div>
              ) : null}
              <div
                data-model-slug={model.slug}
                className={cn(
                  "group grid min-h-8 grid-cols-[20px_minmax(0,1fr)_auto_auto] items-center gap-2.5 px-2 py-1",
                  !isLast && "border-b border-border/40",
                )}
              >
                <Hinted label={checkboxTip}>
                  <Checkbox
                    aria-label={`Show ${model.name} in the model picker`}
                    checked={!hidden}
                    disabled={model.isCustom}
                    onCheckedChange={(checked) => {
                      if (checked === !hidden) return;
                      onHiddenModelsChange(
                        checked
                          ? hiddenModels.filter((slug) => slug !== model.slug)
                          : [...hiddenModels, model.slug],
                      );
                    }}
                  />
                </Hinted>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span
                    className={cn(
                      "truncate text-xs",
                      hidden ? "text-muted-foreground" : "text-foreground/90",
                    )}
                  >
                    {model.name}
                  </span>
                  {model.name !== model.slug ? (
                    <code className="font-mono text-[10.5px] text-muted-foreground/70">
                      {model.slug}
                    </code>
                  ) : null}
                  {model.isCustom ? <span className={chipClass}>custom</span> : null}
                  {capabilityChips(model).map((chip) => (
                    <span key={chip} className={cn(chipClass, "max-sm:hidden")}>
                      {chip}
                    </span>
                  ))}
                </div>
                <div className="flex shrink-0 items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  {!hidden && !filtering ? (
                    <>
                      <Hinted label="Move up">
                        <Button
                          variant="ghost-muted"
                          size="icon-micro"
                          aria-label={`Move ${model.name} up`}
                          disabled={!canMove(-1)}
                          onClick={() => move(model.slug, -1)}
                        >
                          <ArrowUpIcon className="size-3" />
                        </Button>
                      </Hinted>
                      <Hinted label="Move down">
                        <Button
                          variant="ghost-muted"
                          size="icon-micro"
                          aria-label={`Move ${model.name} down`}
                          disabled={!canMove(1)}
                          onClick={() => move(model.slug, 1)}
                        >
                          <ArrowDownIcon className="size-3" />
                        </Button>
                      </Hinted>
                    </>
                  ) : null}
                  {model.isCustom ? (
                    <>
                      <Hinted label="Edit name and options">
                        <Button
                          variant="ghost-muted"
                          size="icon-micro"
                          aria-label={`Edit ${model.slug}`}
                          onClick={() =>
                            setEditingSlug(editingSlug === model.slug ? null : model.slug)
                          }
                        >
                          <PencilIcon className="size-3" />
                        </Button>
                      </Hinted>
                      <Hinted label="Remove custom model">
                        <Button
                          variant="ghost-muted"
                          size="icon-micro"
                          aria-label={`Remove ${model.slug}`}
                          onClick={() => removeCustom(model.slug)}
                        >
                          <XIcon className="size-3" />
                        </Button>
                      </Hinted>
                    </>
                  ) : null}
                </div>
                <Hinted label={favorite ? "Remove from favorites" : "Add to favorites"}>
                  <Button
                    variant="ghost"
                    size="icon-micro"
                    aria-label={
                      favorite
                        ? `Remove ${model.name} from favorites`
                        : `Add ${model.name} to favorites`
                    }
                    className={
                      favorite
                        ? "text-foreground hover:text-foreground/80"
                        : "text-muted-foreground/40 hover:text-muted-foreground"
                    }
                    onClick={() =>
                      onFavoriteModelsChange(
                        favorite
                          ? favoriteModels.filter((slug) => slug !== model.slug)
                          : [...favoriteModels, model.slug],
                      )
                    }
                  >
                    <StarIcon className={cn("size-3", favorite && "fill-current")} />
                  </Button>
                </Hinted>
              </div>
              {editingSlug === model.slug && entry ? (
                <CustomModelEditor
                  instanceId={instanceId}
                  driverKind={driverKind}
                  entry={entry}
                  builtInModels={builtIn}
                  onSave={(next) => {
                    onChange(
                      customModels.map((existing) =>
                        existing.slug === model.slug ? next : existing,
                      ),
                    );
                    setEditingSlug(null);
                  }}
                  onCancel={() => setEditingSlug(null)}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {divBlock}
      {error && driverKind !== "antigravity" ? (
        <p className="mt-2 text-xs text-destructive-foreground">{error}</p>
      ) : null}
    </div>
  );
}
