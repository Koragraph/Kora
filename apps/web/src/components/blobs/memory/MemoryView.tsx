import { cn } from "~/util/utils";
import { Skeleton } from "~/components/ui/skeleton";
import type { BlobMemoryController } from "./useBlobMemory";
import { scopeCaption, filterFacts, scopeTitle, sinceLabel } from "./memoryModel";
import type { HeldMemory } from "./heldStore";
import { PanelEmpty } from "../panel/PanelEmpty";
// The Memory tab, presentational: three groups of facts (About you · this blob's notes · Pending), core notes, search,
// the disclosure line and a warm empty state. All state lives in `useBlobMemory`; this file only draws it and calls
// the handlers it is given.
import type { BlobEpisodeHit, BlobFact } from "@kora/contracts";
import { useEffect, useState, useRef, useId } from "react";
import {
  ChevronRightIcon,
  PencilIcon,
  SearchIcon,
  Trash2Icon,
  BrainIcon,
  StarIcon,
  XIcon,
} from "lucide-react";

export interface MemoryViewProps {
  readonly blobName: string;
  readonly controller: BlobMemoryController;
  readonly held: ReadonlyArray<HeldMemory>;
  readonly onResolveHeld: (receiptId: string, save: boolean) => Promise<string | null>;
  readonly extractor: { readonly learns: boolean; readonly text: string };
  readonly onOpenSource: (threadId: string) => void;
  readonly onForget: (fact: BlobFact) => void;
  readonly searchEpisodes: (query: string) => Promise<ReadonlyArray<BlobEpisodeHit>>;
  readonly now?: number;
}

const iconButton =
  "grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:opacity-50";
const textButton =
  "rounded-md px-2 py-0.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:opacity-50";

// ── a fact ────────────────────────────────────────────────────────────────────────────────────────────────────

function FactRow(props: {
  readonly fact: BlobFact;
  readonly now: number;
  readonly onEdit: (fact: BlobFact, text: string) => Promise<string | null>;
  readonly onStar: (fact: BlobFact) => void;
  readonly onForget: (fact: BlobFact) => void;
  readonly onOpenSource: (threadId: string) => void;
}) {
  const { fact } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.text);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) {
      const field = fieldRef.current;
      field?.focus();
      field?.setSelectionRange(field.value.length, field.value.length);
    }
  }, [editing]);

  const begin = () => {
    setDraft(fact.text);
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    setSaving(true);
    const problem = await props.onEdit(fact, draft);
    setSaving(false);
    if (problem) setError(problem);
    else setEditing(false);
  };

  if (editing) {
    return (
      <li className="px-3 py-2" data-memory-fact={fact.id} data-editing>
        <textarea
          ref={fieldRef}
          value={draft}
          rows={2}
          aria-label="Edit this memory"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void save();
            } else if (event.key === "Escape") {
              setEditing(false);
            }
          }}
          className="field-sizing-content block max-h-40 min-h-[3.25rem] w-full resize-none rounded-lg border border-input bg-background px-2.5 py-1.5 text-[13px] leading-5 text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
        />
        {error ? <p className="mt-1 text-[11.5px] text-destructive-foreground">{error}</p> : null}
        <div className="mt-1.5 flex justify-end gap-1">
          <button
            type="button"
            className={cn(textButton, "text-muted-foreground hover:text-foreground")}
            onClick={() => setEditing(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || draft.trim().length === 0}
            className={cn(textButton, "bg-foreground text-background hover:bg-foreground/90")}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="group/fact flex gap-2 px-3 py-2 hover:bg-accent/30" data-memory-fact={fact.id}>
      <button
        type="button"
        aria-pressed={fact.important}
        aria-label={fact.important ? "Not important" : "Mark important"}
        onClick={() => props.onStar(fact)}
        className={cn(
          iconButton,
          "mt-px",
          fact.important
            ? "text-foreground"
            : "opacity-0 group-hover/fact:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
        )}
      >
        <StarIcon className={cn("size-3.5", fact.important && "fill-current")} aria-hidden />
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]">
          {fact.text}
        </p>
        <p className="mt-0.5 text-[11.5px] leading-4 text-muted-foreground">
          since {sinceLabel(fact.since, props.now)}
          {fact.sourceThreadId ? (
            <>
              {" · "}
              <button
                type="button"
                onClick={() => props.onOpenSource(fact.sourceThreadId!)}
                className="rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
              >
                from a chat
              </button>
            </>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity group-hover/fact:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
        <button type="button" aria-label="Edit memory" className={iconButton} onClick={begin}>
          <PencilIcon className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Forget memory"
          className={iconButton}
          onClick={() => props.onForget(fact)}
        >
          <Trash2Icon className="size-3.5" aria-hidden />
        </button>
      </div>
    </li>
  );
}

function Section(props: {
  readonly title: string;
  readonly caption: string;
  readonly count: number;
  readonly children: React.ReactNode;
  readonly testId: string;
}) {
  return (
    <section aria-label={props.title} data-memory-group={props.testId} className="space-y-1.5">
      <div className="flex items-baseline gap-2 px-1">
        <h3 className="text-[12.5px] font-semibold text-foreground">{props.title}</h3>
        <span className="text-[11.5px] text-muted-foreground">{props.caption}</span>
        <span className="ml-auto text-[11.5px] tabular-nums text-muted-foreground/70">
          {props.count}
        </span>
      </div>
      <div className="overflow-hidden rounded-xl ring-1 ring-border/70">{props.children}</div>
    </section>
  );
}

function FactList(props: {
  readonly facts: ReadonlyArray<BlobFact>;
  readonly emptyText: string;
  readonly now: number;
  readonly controller: BlobMemoryController;
  readonly onForget: (fact: BlobFact) => void;
  readonly onOpenSource: (threadId: string) => void;
}) {
  if (props.facts.length === 0) {
    return (
      <p className="px-3 py-3 text-[12.5px] leading-5 text-muted-foreground">{props.emptyText}</p>
    );
  }
  return (
    <ul className="divide-y divide-border/50">
      {props.facts.map((fact) => (
        <FactRow
          key={fact.id}
          fact={fact}
          now={props.now}
          onEdit={props.controller.edit}
          onStar={(target) => void props.controller.toggleImportant(target)}
          onForget={props.onForget}
          onOpenSource={props.onOpenSource}
        />
      ))}
    </ul>
  );
}

// ── pending ───────────────────────────────────────────────────────────────────────────────────────────────────

function PendingRow(props: {
  readonly item: HeldMemory;
  readonly onResolve: (receiptId: string, save: boolean) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (save: boolean) => {
    setBusy(true);
    const problem = await props.onResolve(props.item.receiptId, save);
    setBusy(false);
    if (problem) setError(problem);
  };
  return (
    <li className="px-3 py-2" data-memory-pending={props.item.receiptId}>
      <p className="text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]">
        {props.item.text}
      </p>
      {props.item.reason ? (
        <p className="mt-0.5 text-[11.5px] leading-4 text-muted-foreground">{props.item.reason}</p>
      ) : null}
      {error ? <p className="mt-0.5 text-[11.5px] text-destructive-foreground">{error}</p> : null}
      <div className="mt-1.5 flex gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => void resolve(true)}
          className={cn(textButton, "bg-foreground text-background hover:bg-foreground/90")}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void resolve(false)}
          className={cn(
            textButton,
            "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          Not this
        </button>
      </div>
    </li>
  );
}

// ── core notes ────────────────────────────────────────────────────────────────────────────────────────────────

function CoreNote(props: {
  readonly label: string;
  readonly hint: string;
  readonly text: string;
  readonly onSave: (text: string) => Promise<string | null>;
  readonly testId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.text);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    const problem = await props.onSave(draft);
    setSaving(false);
    if (problem) setError(problem);
    else setEditing(false);
  };
  return (
    <div className="px-3 py-2.5" data-memory-core={props.testId}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-foreground">{props.label}</p>
          <p className="text-[11.5px] text-muted-foreground">{props.hint}</p>
        </div>
        {!editing ? (
          <button
            type="button"
            className={cn(
              textButton,
              "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            onClick={() => {
              setDraft(props.text);
              setError(null);
              setEditing(true);
            }}
          >
            Edit
          </button>
        ) : null}
      </div>
      {editing ? (
        <>
          <textarea
            value={draft}
            rows={5}
            aria-label={props.label}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
            }}
            className="field-sizing-content mt-2 block max-h-64 min-h-24 w-full resize-none rounded-lg border border-input bg-background px-2.5 py-1.5 text-[12.5px] leading-5 text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          {error ? <p className="mt-1 text-[11.5px] text-destructive-foreground">{error}</p> : null}
          <div className="mt-1.5 flex justify-end gap-1">
            <button
              type="button"
              className={cn(textButton, "text-muted-foreground hover:text-foreground")}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              className={cn(textButton, "bg-foreground text-background hover:bg-foreground/90")}
              onClick={() => void save()}
            >
              Save
            </button>
          </div>
        </>
      ) : props.text.trim().length > 0 ? (
        <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-5 text-foreground/85 [overflow-wrap:anywhere]">
          {props.text}
        </p>
      ) : (
        <p className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">
          Nothing here yet. These fill in as you work together.
        </p>
      )}
    </div>
  );
}

// ── the tab ───────────────────────────────────────────────────────────────────────────────────────────────────

export function MemoryView(props: MemoryViewProps) {
  const { controller, blobName } = props;
  const now = props.now ?? Date.now();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [episodes, setEpisodes] = useState<ReadonlyArray<BlobEpisodeHit>>([]);
  const [coreOpen, setCoreOpen] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      setEpisodes([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void props.searchEpisodes(trimmed).then((hits) => {
        if (!cancelled) setEpisodes(hits);
      });
    }, 300);
    return () => {
      clearTimeout(timer);
      cancelled = true;
    };
  }, [query]);

  const load = controller.load;
  if (load.status === "loading") {
    return (
      <div className="space-y-3 p-3" aria-busy data-memory-loading>
        <Skeleton className="h-8 rounded-lg" />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-11 rounded-xl" />
        ))}
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <PanelEmpty
        icon={BrainIcon}
        title="Couldn’t load memory"
        action={
          <button
            type="button"
            className={cn(textButton, "bg-accent text-foreground hover:bg-accent/80")}
            onClick={controller.refresh}
          >
            Try again
          </button>
        }
      >
        {load.message}
      </PanelEmpty>
    );
  }

  const searching = query.trim().length > 0;
  const you = filterFacts(load.you.facts, query);
  const mine = filterFacts(load.blob.facts, query);
  const team = load.team ? filterFacts(load.team.facts, query) : [];
  const everything =
    load.you.facts.length + load.blob.facts.length + (load.team?.facts.length ?? 0);
  const nothingMatches =
    searching && you.length + mine.length + team.length === 0 && episodes.length === 0;

  const group = (
    facts: ReadonlyArray<BlobFact>,
    scope: "you" | "blob" | "team",
    emptyText: string,
  ) => (
    <Section
      title={scopeTitle(scope, blobName)}
      caption={scopeCaption(scope)}
      count={facts.length}
      testId={scope}
    >
      <FactList
        facts={facts}
        emptyText={emptyText}
        now={now}
        controller={controller}
        onForget={props.onForget}
        onOpenSource={props.onOpenSource}
      />
    </Section>
  );

  return (
    <div className="space-y-4 p-3" data-memory-tab>
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          Search memory
        </label>
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search what I remember"
          className="h-8 w-full rounded-lg border border-input bg-background dark:bg-(--lift-inset-bg) dark:shadow-(--lift-inset-shadow) pr-8 pl-8 text-[13px] text-foreground outline-none placeholder:text-placeholder focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-search-cancel-button]:appearance-none"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            className={cn(iconButton, "absolute top-1/2 right-1.5 -translate-y-1/2")}
            onClick={() => setQuery("")}
          >
            <XIcon className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>

      <p className="px-1 text-[11.5px] leading-4 text-muted-foreground" data-memory-disclosure>
        {props.extractor.text}
      </p>

      {everything === 0 && props.held.length === 0 && !searching ? (
        <div
          className="rounded-xl bg-card px-4 py-5 text-center ring-1 ring-border/70"
          data-memory-empty
        >
          <BrainIcon className="mx-auto mb-2 size-5 text-muted-foreground" aria-hidden />
          <h3 className="text-[13.5px] font-medium text-foreground">
            {blobName} is still getting to know you
          </h3>
          <p className="mx-auto mt-1 max-w-[270px] text-[12.5px] leading-5 text-muted-foreground">
            As you work together, {blobName} remembers what matters: your name, how you like things
            done, what you are working on. You will see each memory here, and you can edit or forget
            any of it.
          </p>
        </div>
      ) : (
        <>
          {props.held.length > 0 && !searching ? (
            <Section
              title="Pending"
              caption="Waiting for your OK"
              count={props.held.length}
              testId="pending"
            >
              <ul className="divide-y divide-border/50">
                {props.held.map((item) => (
                  <PendingRow key={item.receiptId} item={item} onResolve={props.onResolveHeld} />
                ))}
              </ul>
            </Section>
          ) : null}
          {(!searching || you.length > 0) &&
            group(
              you,
              "you",
              "Nothing about you yet. Tell any blob a fact and it lands here for all of them.",
            )}
          {(!searching || mine.length > 0) &&
            group(mine, "blob", `${blobName} has not kept any notes of its own yet.`)}
          {load.team && (!searching || team.length > 0)
            ? group(team, "team", "No team notes yet.")
            : null}
        </>
      )}

      {searching && episodes.length > 0 ? (
        <section aria-label="From past chats" className="space-y-1.5" data-memory-episodes>
          <h3 className="px-1 text-[12.5px] font-semibold text-foreground">From past chats</h3>
          <ul className="divide-y divide-border/50 overflow-hidden rounded-xl ring-1 ring-border/70">
            {episodes.map((hit) => (
              <li key={hit.threadId} className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => props.onOpenSource(hit.threadId)}
                  className="block w-full text-left focus-visible:outline-none"
                >
                  <p className="truncate text-[13px] font-medium text-foreground">{hit.title}</p>
                  <p className="line-clamp-2 text-[12px] leading-4 text-muted-foreground">
                    {hit.summary}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {nothingMatches ? (
        <p className="px-1 text-[12.5px] text-muted-foreground" data-memory-no-match>
          Nothing about “{query.trim()}”.
        </p>
      ) : null}

      <section aria-label="Core notes" className="space-y-1.5">
        <button
          type="button"
          aria-expanded={coreOpen}
          onClick={() => setCoreOpen((open) => !open)}
          className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              coreOpen && "rotate-90",
            )}
            aria-hidden
          />
          <span className="text-[12.5px] font-semibold text-foreground">Core notes</span>
          <span className="text-[11.5px] text-muted-foreground">
            Short notes {blobName} reads every turn. Kora writes them overnight; what it has learned
            shows above and is used right away.
          </span>
        </button>
        {coreOpen ? (
          <div className="divide-y divide-border/50 overflow-hidden rounded-xl ring-1 ring-border/70">
            <CoreNote
              testId="you"
              label="About you"
              hint="Every blob reads this on every turn."
              text={load.you.core}
              onSave={(text) => controller.saveCore("you", text)}
            />
            <CoreNote
              testId="blob"
              label={`${blobName}'s working notes`}
              hint="How it works for you. Keep it short."
              text={load.blob.core}
              onSave={(text) => controller.saveCore("blob", text)}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}
