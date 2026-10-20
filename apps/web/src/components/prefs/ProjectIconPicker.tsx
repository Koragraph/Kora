import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { ScrollArea } from "../ui/scroll-area";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogPanel,
  DialogDescription,
  DialogTitle,
  DialogHeader,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { ProjectInitials } from "../ProjectInitials";
import { deriveProjectIdentity } from "../../workspace/projectIdentity";
import { cn } from "../../util/utils";
import {
  projectIconColorClassName,
  filterProjectIconNames,
  PROJECT_ICON_COLORS,
  PROJECT_EMOJIS,
  firstEmoji,
} from "../../appearance/projectIconOptions";
import {
  type ProjectIconOverride,
  ProjectMonogramText,
  type ProjectBadgeColor,
} from "@kora/contracts";
import { useEffect, Suspense, useState, lazy } from "react";
import * as Schema from "effect/Schema";

type Mode = "lucide" | "emoji" | "monogram";

const DEFAULT_ICON = "folder-code";
const DEFAULT_EMOJI = "💻";

const LazyDynamicIcon = lazy(() =>
  import("lucide-react/dynamic").then((mod) => ({ default: mod.DynamicIcon })),
);

function SymbolGlyph({ name, className }: { name: string; className: string }) {
  return (
    <Suspense fallback={<span className={className} />}>
      <LazyDynamicIcon name={name as never} className={className} />
    </Suspense>
  );
}

const isValidMonogram = Schema.is(ProjectMonogramText);
const normalizeLetters = (value: string) => value.normalize("NFKC").trim().toUpperCase();
const titleCase = (hyphenated: string) =>
  hyphenated
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

interface Draft {
  mode: Mode;
  iconName: string;
  color: ProjectBadgeColor;
  letters: string;
  emoji: string;
}

function initialDraft(current: ProjectIconOverride | null, projectName: string): Draft {
  const automatic = deriveProjectIdentity(projectName);
  const monogram = current?.kind === "lucide" ? current.monogram : undefined;
  return {
    mode: monogram ? "monogram" : (current?.kind ?? "lucide"),
    iconName: current?.kind === "lucide" ? current.name : DEFAULT_ICON,
    color: current && current.kind !== "emoji" ? current.color : automatic.color,
    letters: monogram ?? automatic.monogram,
    emoji: current?.kind === "emoji" ? current.emoji : DEFAULT_EMOJI,
  };
}

export function ProjectIconPicker(props: {
  readonly open: boolean;
  readonly projectName: string;
  readonly current: ProjectIconOverride | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (icon: ProjectIconOverride) => void;
}) {
  const { current, projectName, open, onOpenChange, onSelect } = props;
  const [draft, setDraft] = useState(() => initialDraft(current, projectName));
  const [query, setQuery] = useState("");
  const [customEmoji, setCustomEmoji] = useState("");

  // Every time the dialog opens it starts from what is currently saved.
  useEffect(() => {
    if (!open) return;
    setDraft(initialDraft(current, projectName));
    setQuery("");
    setCustomEmoji("");
  }, [open]);

  const patch = (next: Partial<Draft>) => setDraft((existing) => ({ ...existing, ...next }));
  const automatic = deriveProjectIdentity(projectName);
  const letters = normalizeLetters(draft.letters);
  const lettersValid = isValidMonogram(letters);
  const colorClass = projectIconColorClassName(draft.color);
  const names = filterProjectIconNames(query);

  const save = () => {
    if (draft.mode === "monogram") {
      if (!lettersValid) return;
      onSelect({
        kind: "lucide",
        name: DEFAULT_ICON as never,
        monogram: letters,
        color: draft.color,
      });
    } else if (draft.mode === "lucide") {
      onSelect({ kind: "lucide", name: draft.iconName as never, color: draft.color });
    } else {
      onSelect({ kind: "emoji", emoji: draft.emoji });
    }
    onOpenChange(false);
  };

  const preview =
    draft.mode === "emoji" ? (
      <span className="text-2xl leading-none">{draft.emoji}</span>
    ) : draft.mode === "monogram" ? (
      <ProjectInitials
        text={lettersValid ? letters : automatic.monogram}
        color={draft.color}
        className="size-8"
      />
    ) : (
      <SymbolGlyph name={draft.iconName} className={cn("size-6", colorClass)} />
    );

  const cell =
    "flex aspect-square items-center justify-center rounded-md border border-transparent hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-card">
              {preview}
            </div>
            <div className="min-w-0">
              <DialogTitle>Give this project a face</DialogTitle>
              <DialogDescription>
                A symbol, an emoji or a couple of letters, whichever you spot fastest in the
                sidebar.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogPanel className="flex min-h-0 flex-col gap-4">
          <ToggleGroup
            aria-label="Icon type"
            value={[draft.mode]}
            onValueChange={(next) => {
              const mode = next[0] as Mode | undefined;
              if (mode) patch({ mode });
            }}
          >
            <Toggle value="lucide">Icons</Toggle>
            <Toggle value="emoji">Emoji</Toggle>
            <Toggle value="monogram">Letters</Toggle>
          </ToggleGroup>

          {draft.mode !== "emoji" ? (
            <div>
              <div className="mb-2 text-xs font-medium text-muted-foreground">Color</div>
              <div role="group" aria-label="Icon color" className="flex flex-wrap gap-1.5">
                {PROJECT_ICON_COLORS.map((option) => {
                  const selected = draft.color === option.value;
                  return (
                    <button
                      className={cn(
                        "flex size-6 items-center justify-center rounded-full border focus-visible:ring-2 focus-visible:ring-ring",
                        selected ? "border-foreground/64" : "border-transparent",
                      )}
                      onClick={() => patch({ color: option.value })}
                      aria-label={option.label}
                      aria-pressed={selected}
                      key={option.value}
                      type="button"
                    >
                      <span className={cn("size-4 rounded-full", option.swatchClassName)} />
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {draft.mode === "lucide" ? (
            <>
              <Input
                type="search"
                aria-label="Find a symbol"
                placeholder="Find a symbol (folder, rocket, bug…)"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <ScrollArea scrollFade className="max-h-64">
                {names.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No symbol by that name.
                  </p>
                ) : (
                  <div className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10">
                    {names.map((name) => {
                      const selected = name === draft.iconName;
                      return (
                        <button
                          key={name}
                          type="button"
                          aria-label={titleCase(name)}
                          aria-pressed={selected}
                          className={cn(cell, selected && "border-border bg-accent")}
                          onClick={() => patch({ iconName: name })}
                        >
                          <SymbolGlyph name={name} className={cn("size-5", colorClass)} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
            </>
          ) : null}

          {draft.mode === "emoji" ? (
            <>
              <ScrollArea scrollFade className="max-h-64">
                <div className="grid grid-cols-8 gap-1 p-0.5 sm:grid-cols-10">
                  {PROJECT_EMOJIS.map((entry) => {
                    const selected = entry.emoji === draft.emoji;
                    return (
                      <button
                        key={entry.emoji}
                        type="button"
                        aria-label={entry.label}
                        aria-pressed={selected}
                        className={cn(cell, "text-xl", selected && "border-border bg-accent")}
                        onClick={() => patch({ emoji: entry.emoji })}
                      >
                        {entry.emoji}
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
              <div>
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  Not here? Paste one
                </div>
                <Input
                  aria-label="Custom emoji"
                  placeholder="Paste an emoji"
                  value={customEmoji}
                  onChange={(event) => {
                    const value = event.target.value;
                    setCustomEmoji(value);
                    const found = firstEmoji(value);
                    if (found) patch({ emoji: found });
                  }}
                />
              </div>
            </>
          ) : null}

          {draft.mode === "monogram" ? (
            <div className="flex items-center gap-4 py-2">
              <ProjectInitials
                text={lettersValid ? letters : automatic.monogram}
                color={draft.color}
                className="size-12"
              />
              <div className="flex flex-1 flex-col gap-2">
                <label htmlFor="project-monogram" className="text-sm font-medium">
                  Letters
                </label>
                <Input
                  id="project-monogram"
                  autoComplete="off"
                  value={draft.letters}
                  aria-invalid={!lettersValid}
                  aria-describedby="project-monogram-hint"
                  onChange={(event) => patch({ letters: event.target.value })}
                />
                <p id="project-monogram-hint" className="text-xs text-muted-foreground">
                  Up to two letters or digits.
                </p>
              </div>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button disabled={draft.mode === "monogram" && !lettersValid} onClick={save}>
            Save icon
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
