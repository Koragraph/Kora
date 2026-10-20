// Kora's first message: who she is, what she does, and the two ways in. Rendered in Kora's chat canvas when she has
// no messages yet (SPEC "First-run UX"). Presentational: the host supplies the two actions.
import { SparklesIcon, UsersRoundIcon } from "lucide-react";
import type { ReactNode } from "react";

import { BlobAvatar, STARTER_OUTFITS } from "~/components/blobs/avatar";
import { Button } from "../../ui/button";
import "../gallery/gallery.css";

const KORA_WELCOME_TEXT = {
  greeting: "I’m Kora.",
  body: "I run your team of blobs. Message any of them directly, or bring me the bigger jobs and I’ll split them up. Pick a few to hire, or tell me what you need and I’ll build one.",
  hint: "You can message any blob directly. You only need me for jobs that span several.",
  steps: [
    "Sign in to Claude (the button above, if it shows; no Terminal needed).",
    "Browse the roster and hire a few blobs, or ask me to build one.",
    "Send your first message. Want to code instead? Switch to Code at the top.",
  ],
} as const;

export function KoraWelcome(props: {
  readonly onBrowse: () => void;
  readonly onBuild: () => void;
  readonly outfit?: typeof STARTER_OUTFITS.kora;
  /** The sign-in / setup card: lives inside the welcome, because the welcome covers the whole transcript. */
  readonly setup?: ReactNode;
}) {
  return (
    <div
      className="mx-auto flex h-full w-full max-w-[34rem] flex-col items-center justify-center px-6 py-10 text-center"
      data-kora-welcome
    >
      <div className="p2-pop mb-4 grid place-items-center" data-kora-welcome-avatar>
        <BlobAvatar
          outfit={props.outfit ?? STARTER_OUTFITS.kora}
          state="idle"
          size={96}
          chief
          badge
          reaction="wave"
          label="Kora, the Chief, waving"
        />
      </div>
      <h1
        className="p2-fade text-[26px] font-semibold leading-8 tracking-[-0.02em] text-foreground"
        style={{ "--i": 1 } as React.CSSProperties}
      >
        {KORA_WELCOME_TEXT.greeting}
      </h1>
      <p
        className="p2-fade mt-3 max-w-[30rem] text-[15px] leading-6 text-muted-foreground"
        style={{ "--i": 2 } as React.CSSProperties}
      >
        {KORA_WELCOME_TEXT.body}
      </p>
      {props.setup ? (
        <div className="p2-fade mt-5 w-full max-w-md" style={{ "--i": 2 } as React.CSSProperties}>
          {props.setup}
        </div>
      ) : null}
      <div
        className="p2-fade mt-7 flex flex-wrap items-center justify-center gap-2.5"
        style={{ "--i": 3 } as React.CSSProperties}
      >
        <Button size="lg" onClick={props.onBrowse} data-welcome-browse>
          <UsersRoundIcon />
          Browse the roster
        </Button>
        <Button size="lg" variant="outline" onClick={props.onBuild} data-welcome-build>
          <SparklesIcon />
          Build me a blob
        </Button>
      </div>
      <ol
        className="p2-fade mt-6 max-w-[30rem] list-decimal space-y-1 ps-5 text-start text-[13px] leading-5 text-muted-foreground"
        style={{ "--i": 4 } as React.CSSProperties}
        data-kora-welcome-steps
      >
        {KORA_WELCOME_TEXT.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p
        className="p2-fade mt-4 text-[12.5px] leading-5 text-muted-foreground/75"
        style={{ "--i": 4 } as React.CSSProperties}
      >
        {KORA_WELCOME_TEXT.hint}
      </p>
    </div>
  );
}
