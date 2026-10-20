// The Kora surface's empty-state headline: a calm greeting + starter chips that fill the
// composer, instead of DraftStageHeadline's Code-surface greeting. Mirrors its layout/typography.
import { KoraMark } from "../KoraWordmark";

const BLOB_STARTER_CHIPS = [
  "Research something for me",
  "Draft a document",
  "Make a spreadsheet",
  "Plan something",
] as const;
const CHIEF_STARTER_CHIPS = [
  "Plan a project with the team",
  "Hire a new blob",
  "Who is on my team?",
  "Plan something",
] as const;

const STARTER_CHIPS = [
  "Research a topic in depth",
  "Analyze these files",
  "Draft a document",
  "Plan something",
] as const;

export function ChatHero(props: {
  /** A blob's empty thread: greets by name, with chips that fit a coworker. */
  readonly blob?: { readonly name: string; readonly chief: boolean } | null;
  readonly onPickStarter: (text: string) => void;
}) {
  return (
    <div
      data-chat-hero
      className="mx-auto flex w-full max-w-2xl flex-col items-center gap-5 text-center"
    >
      <h1 className="flex items-center justify-center gap-2.5 text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        <KoraMark className="size-6 shrink-0 opacity-90 sm:size-8" />
        <span>
          {props.blob
            ? props.blob.chief
              ? "What should we plan?"
              : `What can ${props.blob.name} help with?`
            : "What should we work on?"}
        </span>
      </h1>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {(props.blob
          ? props.blob.chief
            ? CHIEF_STARTER_CHIPS
            : BLOB_STARTER_CHIPS
          : STARTER_CHIPS
        ).map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => props.onPickStarter(chip)}
            className="rounded-full border border-border bg-card px-3.5 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
          >
            {chip}
          </button>
        ))}
      </div>
    </div>
  );
}
