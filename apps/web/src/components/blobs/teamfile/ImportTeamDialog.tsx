import { cn } from "~/util/utils";
// Import a team file: choose a file, drop one, or paste an https link (or the text). The file is untrusted, so nothing is
// created from this screen's first step: the daemon reads and validates it and answers with a PLAN, and this dialog's
// second step is the review of that plan - every blob and group that will be created, under its final (de-duplicated)
// name, with the safe defaults spelled out - before a single thing exists. Untick what you do not want.
import { Hint } from "~/components/ui/hint";
import { BlobAvatar } from "~/components/blobs/avatar";
import {
  defaultImportSkips,
  importButtonLabel,
  IMPORT_MAX_BYTES,
  type ImportResultWire,
  type PlannedBlobWire,
  type ExistingChoice,
  type ImportPlanWire,
  type TeamImportApi,
  importCounts,
  looksLikeUrl,
  doneSummary,
  flagIsRisky,
  FLAG_LABEL,
  toggleId,
  plural,
} from "./teamfileModel";
import { toAvatarOutfit } from "../outfit";
import { Textarea } from "../../ui/textarea";
import { Spinner } from "../../ui/spinner";
import { Input } from "../../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogDescription,
  DialogTitle,
  DialogHeader,
  DialogFooter,
} from "../../ui/dialog";
import { Button } from "../../ui/button";
import { type DragEvent, useState, useRef } from "react";
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  ShieldCheckIcon,
  FileTextIcon,
  CheckIcon,
  PauseIcon,
  Undo2Icon,
  LinkIcon,
  LockIcon,
} from "lucide-react";

type Stage =
  | { readonly kind: "source" }
  | { readonly kind: "loading"; readonly what: string }
  | { readonly kind: "review"; readonly plan: ImportPlanWire }
  | { readonly kind: "applying"; readonly plan: ImportPlanWire }
  | { readonly kind: "done"; readonly plan: ImportPlanWire; readonly result: ImportResultWire };

/** The safety promises, always on screen. They are enforced by the importer, not by this text. */
const GUARANTEES: ReadonlyArray<{ readonly icon: typeof LockIcon; readonly text: string }> = [
  { icon: LockIcon, text: "Apps off" },
  { icon: PauseIcon, text: "Routines paused" },
  { icon: ShieldCheckIcon, text: "Skills off" },
  { icon: Undo2Icon, text: "Kora untouched" },
];

function GuaranteeStrip() {
  return (
    <ul className="flex flex-wrap gap-1.5" data-import-guarantees aria-label="Import safety">
      {GUARANTEES.map((g) => (
        <li
          key={g.text}
          className="inline-flex h-6 items-center gap-1 rounded-full bg-foreground/[0.06] px-2 text-[11.5px] font-medium text-foreground/85"
        >
          <g.icon className="size-3" aria-hidden />
          {g.text}
        </li>
      ))}
    </ul>
  );
}

function BlobReviewRow(props: {
  readonly b: PlannedBlobWire;
  readonly on: boolean;
  readonly onToggle: () => void;
  readonly choice: ExistingChoice;
  readonly onChoice: (c: ExistingChoice) => void;
}) {
  const { b } = props;
  const [open, setOpen] = useState(false);
  const outfit = toAvatarOutfit(b.outfit, b.name);
  return (
    <li
      className={cn(
        "rounded-xl ring-1 transition-colors ring-inset",
        props.on ? "ring-border" : "opacity-55 ring-border/60",
      )}
      data-import-blob={b.name}
    >
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <button
          type="button"
          role="checkbox"
          aria-checked={props.on}
          aria-label={`Import ${b.name}`}
          onClick={props.onToggle}
          className={cn(
            "grid size-[18px] shrink-0 place-items-center rounded-md ring-1 ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            props.on ? "bg-foreground text-background ring-foreground" : "ring-border",
          )}
        >
          {props.on ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
        </button>
        <span className="grid size-9 shrink-0 place-items-center">
          <BlobAvatar outfit={outfit} size={32} still eyesFollowCursor={false} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-[13.5px] font-medium">{b.name}</span>
            {b.renamed && props.on && props.choice === "keep" ? (
              <Hint label={`The file calls it ${b.fileName}; you already have that name.`}>
                <span className="shrink-0 text-[11px] text-muted-foreground" data-import-renamed>
                  was {b.fileName}
                </span>
              </Hint>
            ) : null}
          </span>
          <span className="block truncate text-[11.5px] text-muted-foreground">
            {[
              b.title,
              b.skills.length ? `${plural(b.skills.length, "skill")} (off)` : null,
              b.routines.length ? `${plural(b.routines.length, "routine")} (paused)` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "Personality only"}
          </span>
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? `Hide ${b.name}'s personality` : `Read ${b.name}'s personality`}
          onClick={() => setOpen((v) => !v)}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
      </div>
      {b.existing ? (
        <div
          className="flex flex-wrap items-center gap-2 px-2.5 pb-2 pl-[3.1rem] text-[11.5px] text-muted-foreground"
          data-import-existing={b.existing.identical ? "identical" : "different"}
        >
          <span>
            {b.existing.identical
              ? `You already have ${b.fileName}, exactly like this.`
              : `You already have a ${b.fileName}, and this one is different.`}
          </span>
          <span
            role="radiogroup"
            aria-label={`What to do with ${b.fileName}`}
            className="inline-flex overflow-hidden rounded-md ring-1 ring-border ring-inset"
          >
            {(["keep", "replace", "skip"] as const).map((c) => {
              const checked = c === "skip" ? !props.on : props.on && props.choice === c;
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  data-import-choice={c}
                  onClick={() => {
                    if (c === "skip") {
                      if (props.on) props.onToggle();
                      return;
                    }
                    if (!props.on) props.onToggle();
                    props.onChoice(c);
                  }}
                  className={cn(
                    "h-6 px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    checked ? "bg-foreground text-background" : "hover:bg-muted",
                  )}
                >
                  {c === "keep"
                    ? `Keep both (${b.name})`
                    : c === "replace"
                      ? "Replace mine"
                      : "Skip"}
                </button>
              );
            })}
          </span>
          {!props.on ? <span data-import-skipped>Skipped: nothing changes.</span> : null}
        </div>
      ) : null}
      {b.flags.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5 px-2.5 pb-2 pl-[3.1rem]" data-import-flags>
          {b.flags.map((f) => (
            <Hint label={f.text}>
              <li
                key={f.kind}
                data-flag={f.kind}
                className={cn(
                  "inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-[10.5px] font-medium",
                  flagIsRisky(f.kind)
                    ? "bg-foreground text-background"
                    : "bg-foreground/[0.07] text-muted-foreground",
                )}
              >
                {flagIsRisky(f.kind) || f.kind === "link" ? (
                  <AlertTriangleIcon className="size-3" aria-hidden />
                ) : null}
                {FLAG_LABEL[f.kind]}
              </li>
            </Hint>
          ))}
        </ul>
      ) : null}
      {open ? (
        <div className="border-t border-border/70 px-3 py-2.5 text-[12px]" data-import-detail>
          <div className="mb-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Personality
          </div>
          <pre className="max-h-44 overflow-auto leading-relaxed [font-family:inherit] whitespace-pre-wrap text-foreground/90">
            {b.soul || "(empty)"}
          </pre>
          {b.routines.length > 0 ? (
            <ul className="mt-2 list-disc pl-4 text-muted-foreground">
              {b.routines.map((r) => (
                <li key={r.title}>
                  {r.title}
                  {r.cadence ? ` (${r.cadence})` : ""} - paused
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function ImportTeamDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly api: TeamImportApi;
  /** Called after a successful import so the host can open the new blobs / group. */
  readonly onImported?: (result: ImportResultWire) => void;
  /** Start straight at a review (tests, screenshots). */
  readonly initialPlan?: ImportPlanWire;
}) {
  const [stage, setStage] = useState<Stage>(
    props.initialPlan ? { kind: "review", plan: props.initialPlan } : { kind: "source" },
  );
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [showText, setShowText] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipBlobs, setSkipBlobs] = useState<string[]>(() =>
    props.initialPlan ? defaultImportSkips(props.initialPlan) : [],
  );
  const [replaceBlobs, setReplaceBlobs] = useState<string[]>([]);
  const [replacedNames, setReplacedNames] = useState<string[]>([]);
  const [skipGroups, setSkipGroups] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setStage({ kind: "source" });
    setUrl("");
    setText("");
    setError(null);
    setSkipBlobs([]);
    setReplaceBlobs([]);
    setSkipGroups([]);
  };
  const close = () => {
    props.onOpenChange(false);
    setTimeout(reset, 200);
  };

  const planFrom = async (what: string, run: () => ReturnType<TeamImportApi["fromText"]>) => {
    setError(null);
    setStage({ kind: "loading", what });
    const r = await run();
    if (!r.ok) {
      setStage({ kind: "source" });
      setError(r.message);
      return;
    }
    // a blob you already have in identical form starts unticked (it would add nothing)
    setSkipBlobs(defaultImportSkips(r.value));
    setReplaceBlobs([]);
    setSkipGroups([]);
    setStage({ kind: "review", plan: r.value });
  };

  const readFile = async (file: File) => {
    if (file.size > IMPORT_MAX_BYTES) {
      setError(
        `That file is too big for a team file (max ${Math.round(IMPORT_MAX_BYTES / 1024)} KB).`,
      );
      return;
    }
    let content: string;
    try {
      content = await file.text();
    } catch {
      setError("Could not read that file.");
      return;
    }
    await planFrom(file.name, () => props.api.fromText(content));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void readFile(f);
  };

  const review = stage.kind === "review" || stage.kind === "applying" ? stage.plan : null;
  const counts = review ? importCounts(review, { blobs: skipBlobs, groups: skipGroups }) : null;
  const nothing = counts ? counts.blobs === 0 && counts.groups === 0 : true;

  const apply = async () => {
    if (!review || stage.kind !== "review" || nothing) return;
    setStage({ kind: "applying", plan: review });
    setError(null);
    const r = await props.api.apply(review.planId, {
      blobs: skipBlobs,
      groups: skipGroups,
      replace: replaceBlobs.filter((n) => !skipBlobs.includes(n)),
    });
    if (!r.ok) {
      setStage({ kind: "review", plan: review });
      setError(r.message);
      return;
    }
    setReplacedNames(replaceBlobs.filter((n) => !skipBlobs.includes(n)));
    setStage({ kind: "done", plan: review, result: r.value });
    props.onImported?.(r.value);
  };

  return (
    <Dialog open={props.open} onOpenChange={(o) => (o ? props.onOpenChange(true) : close())}>
      <DialogPopup className="max-w-lg" data-import-dialog={stage.kind}>
        {stage.kind === "source" || stage.kind === "loading" ? (
          <>
            <DialogHeader>
              <DialogTitle>Import a team</DialogTitle>
              <DialogDescription>
                Open a Kora team file to hire its blobs and set up its groups. You will see
                everything it creates first.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4 px-6 pb-2">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={onDrop}
                data-import-drop
                className={cn(
                  "flex flex-col items-center gap-2 rounded-2xl border border-dashed px-4 py-7 text-center transition-colors",
                  over ? "border-foreground/60 bg-foreground/[0.05]" : "border-border",
                )}
              >
                <FileTextIcon className="size-6 text-muted-foreground" aria-hidden />
                <div className="text-[13.5px] font-medium">Drop a .md team file here</div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={stage.kind === "loading"}
                  onClick={() => fileInput.current?.click()}
                  data-import-choose
                >
                  Choose file…
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".md,.markdown,text/markdown,text/plain"
                  className="hidden"
                  data-import-file
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void readFile(f);
                  }}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[12.5px] font-medium" htmlFor="team-import-url">
                  Or paste a link
                </label>
                <div className="flex gap-2">
                  <span className="relative min-w-0 flex-1">
                    <LinkIcon
                      className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                      aria-hidden
                    />
                    <Input
                      id="team-import-url"
                      value={url}
                      onChange={(e) => {
                        setUrl(e.target.value);
                        setError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && looksLikeUrl(url))
                          void planFrom("the link", () => props.api.fromUrl(url.trim()));
                      }}
                      placeholder="https://…/crew.kora-team.md"
                      autoComplete="off"
                      spellCheck={false}
                      className="[&_input]:pl-8"
                      data-import-url
                    />
                  </span>
                  <Button
                    disabled={!looksLikeUrl(url) || stage.kind === "loading"}
                    onClick={() => void planFrom("the link", () => props.api.fromUrl(url.trim()))}
                    data-import-fetch
                  >
                    Open
                  </Button>
                </div>
                <span className="text-[11.5px] text-muted-foreground">
                  Only https links. Kora reads the text and nothing else from it.
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <button
                  type="button"
                  className="self-start text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => setShowText((v) => !v)}
                  aria-expanded={showText}
                >
                  {showText ? "Hide pasted text" : "Paste the file's text instead"}
                </button>
                {showText ? (
                  <>
                    <Textarea
                      className="max-h-44 overflow-y-auto"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      rows={5}
                      placeholder="---&#10;kora_team: 1&#10;…"
                      aria-label="Team file text"
                      data-import-text
                    />
                    <Button
                      className="self-end"
                      size="sm"
                      disabled={!text.trim() || stage.kind === "loading"}
                      onClick={() =>
                        void planFrom("the pasted text", () => props.api.fromText(text))
                      }
                      data-import-read
                    >
                      Read it
                    </Button>
                  </>
                ) : null}
              </div>

              {stage.kind === "loading" ? (
                <p
                  className="flex items-center gap-2 text-[12.5px] text-muted-foreground"
                  role="status"
                >
                  <Spinner className="size-3.5" /> Reading {stage.what}…
                </p>
              ) : null}
              {error ? (
                <p
                  role="alert"
                  className="text-[12.5px] text-destructive-foreground"
                  data-import-error
                >
                  {error}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {review && counts ? (
          <>
            <DialogHeader>
              <DialogTitle>Review before importing</DialogTitle>
              <DialogDescription>
                {review.title}
                {review.description ? ` - ${review.description}` : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="flex max-h-[min(74vh,700px)] flex-col gap-4 overflow-y-auto px-6 pb-2">
              <GuaranteeStrip />

              {review.warnings.length > 0 ? (
                <ul className="text-[12px] text-muted-foreground" data-import-warnings>
                  {review.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : null}

              <section aria-label="Blobs it creates">
                <div className="px-1 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase">
                  Blobs ({counts.blobs} of {review.blobs.length})
                </div>
                <ul className="flex flex-col gap-1.5">
                  {review.blobs.map((b) => (
                    <BlobReviewRow
                      key={b.name}
                      b={b}
                      on={!skipBlobs.includes(b.name)}
                      onToggle={() => setSkipBlobs(toggleId(skipBlobs, b.name))}
                      choice={replaceBlobs.includes(b.name) ? "replace" : "keep"}
                      onChoice={(c) =>
                        setReplaceBlobs(
                          c === "replace"
                            ? [...replaceBlobs.filter((n) => n !== b.name), b.name]
                            : replaceBlobs.filter((n) => n !== b.name),
                        )
                      }
                    />
                  ))}
                </ul>
              </section>

              {review.groups.length > 0 ? (
                <section aria-label="Groups it creates">
                  <div className="px-1 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase">
                    Groups ({counts.groups} of {review.groups.length})
                  </div>
                  <ul className="flex flex-col gap-1.5">
                    {review.groups.map((g) => {
                      const off = skipGroups.includes(g.name);
                      const dropped = counts.droppedGroups.includes(g.name);
                      return (
                        <li
                          key={g.name}
                          className={cn(
                            "flex items-center gap-2.5 rounded-xl px-2.5 py-2 ring-1 ring-inset",
                            off || dropped ? "opacity-55 ring-border/60" : "ring-border",
                          )}
                          data-import-group={g.name}
                        >
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={!off}
                            aria-label={`Import group ${g.name}`}
                            onClick={() => setSkipGroups(toggleId(skipGroups, g.name))}
                            className={cn(
                              "grid size-[18px] shrink-0 place-items-center rounded-md ring-1 ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              !off
                                ? "bg-foreground text-background ring-foreground"
                                : "ring-border",
                            )}
                          >
                            {!off ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
                          </button>
                          <span
                            aria-hidden
                            className="w-6 shrink-0 text-center text-[15px] font-medium text-muted-foreground"
                          >
                            #
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-1.5">
                              <span className="truncate text-[13.5px] font-medium">{g.name}</span>
                              {g.renamed ? (
                                <span className="shrink-0 text-[11px] text-muted-foreground">
                                  was {g.fileName}
                                </span>
                              ) : null}
                            </span>
                            <span className="block truncate text-[11.5px] text-muted-foreground">
                              {g.members.join(", ")} · lead {g.lead} ·{" "}
                              {g.rule === "auto"
                                ? "auto replies"
                                : g.rule === "lead"
                                  ? "lead answers"
                                  : "mention only"}
                            </span>
                            {dropped ? (
                              <span className="block text-[11.5px] text-muted-foreground">
                                Skipped: fewer than two members left.
                              </span>
                            ) : null}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}

              <ul
                className="flex flex-col gap-1 text-[12px] text-muted-foreground"
                data-import-notes
              >
                {review.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>

              {review.skipped.length > 0 ? (
                <details className="text-[12px] text-muted-foreground" data-import-skipped>
                  <summary className="cursor-pointer select-none">
                    Not imported ({review.skipped.length})
                  </summary>
                  <ul className="mt-1.5 flex flex-col gap-1 pl-3">
                    {review.skipped.map((s) => (
                      <li key={s.what}>
                        <span className="font-medium text-foreground/85">{s.what}</span> - {s.why}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              {error ? (
                <p
                  role="alert"
                  className="text-[12.5px] text-destructive-foreground"
                  data-import-error
                >
                  {error}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={reset} disabled={stage.kind === "applying"}>
                Back
              </Button>
              <Button
                onClick={() => void apply()}
                disabled={nothing || stage.kind === "applying"}
                data-import-apply
              >
                {stage.kind === "applying" ? "Importing…" : importButtonLabel(counts)}
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {stage.kind === "done" ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {stage.result.errors.length === 0 ? "Imported" : "Imported with problems"}
              </DialogTitle>
              <DialogDescription>
                {doneSummary(stage.result, replacedNames)}. Turn on routines and skills, and connect
                apps, from each blob's profile when you are ready.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3 px-6 pb-2">
              <GuaranteeStrip />
              {stage.result.errors.length > 0 ? (
                <ul
                  role="alert"
                  className="text-[12.5px] text-destructive-foreground"
                  data-import-failures
                >
                  {stage.result.errors.map((e) => (
                    <li key={e.what}>
                      {e.what}: {e.error}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <DialogFooter>
              <Button onClick={close} data-import-close>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
