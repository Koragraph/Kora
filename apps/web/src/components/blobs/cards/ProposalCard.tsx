// The "Build me a blob" result: Kora's proposal for a new blob. A live preview (tap it to try another look), an
// inline-editable name, what it does and how, its model and permission level, the apps / skills / routines it would
// come with (apps are Connect chips; routines arrive paused), and Hire · Tweak · Not this.
// Versioned in place: when Kora revises the proposal the card updates and says "v2". Once hired it collapses to a
// one-line receipt.
import { Hint } from "~/components/ui/hint";
import type { BlobDraft, BlobProfile } from "@kora/contracts";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilIcon,
  ShuffleIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { BlobAvatar, OutfitPicker, type BlobOutfit } from "~/components/blobs/avatar";
import { cn } from "~/util/utils";
import type { BlobCardRef } from "../../../thread/timeline";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { ConnectChip } from "../apps/ConnectChip";
import { NAME_MAX } from "../editor/blobDraft";
import { landAndWave } from "../gallery/HireFlyIn";
import { flyToRoster, rectOf } from "../gallery/flyToRoster";
import { fromAvatarOutfit } from "../outfit";
import { useEngineLabel } from "../shell/useEngineLabel";
import type { ApiResult } from "./blobCommand";
import {
  PERMISSION_COPY,
  describeOutfit,
  howItWorks,
  latestVersion,
  lookDeck,
  modelLabel,
  parseProposal,
  proposalOutfit,
  stepLook,
  type ProposalView,
} from "./proposalModel";
import type { ProposalActions } from "./teamCardActions";
import "../gallery/gallery.css";

export interface ProposalCardProps {
  readonly card: BlobCardRef;
  readonly actions: ProposalActions;
  /** Open the full editor pre-filled with `draft` (and which proposal it came from). Omitted => no Tweak button. */
  readonly onTweak?: (draft: BlobDraft, proposalId: string) => void;
  /** After a successful Hire (the new profile exists). */
  readonly onHired?: (profile: BlobProfile) => void;
  /** Skip the roster fly-in (tests). */
  readonly flyIn?: boolean;
}

export function ProposalCard(props: ProposalCardProps) {
  const incoming = useMemo(() => parseProposal(props.card), [props.card]);
  // A late, older frame never rolls the card back.
  const seen = useRef<ProposalView | null>(null);
  if (incoming) seen.current = latestVersion(seen.current, incoming);
  const view = seen.current;
  const [receipt, setReceipt] = useState<{ name: string; blobId: string } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  if (!view) return null;

  if (receipt || view.state === "hired") {
    return (
      <HiredReceipt
        name={receipt?.name ?? view.draft.name}
        outfit={proposalOutfit(view.draft, view.cardId)}
        blobId={receipt?.blobId ?? view.hiredBlobId ?? view.cardId}
        fresh={receipt !== null}
      />
    );
  }
  if (dismissed || view.state === "dismissed") {
    return (
      <div
        data-blob-card="proposal"
        data-proposal-state="dismissed"
        className="flex w-fit items-center gap-2 py-0.5 text-[12.5px] leading-5 text-muted-foreground/70"
      >
        <SparklesIcon className="size-3.5" aria-hidden />
        Skipped the {view.draft.name} idea
      </div>
    );
  }
  return (
    <OpenProposal
      key={view.version /* a revised proposal starts from Kora's new draft, not the old edits */}
      view={view}
      actions={props.actions}
      {...(props.onTweak ? { onTweak: props.onTweak } : {})}
      {...(props.onHired ? { onHired: props.onHired } : {})}
      flyIn={props.flyIn !== false}
      onHiredLocal={(name, blobId) => setReceipt({ name, blobId })}
      onDismissedLocal={() => setDismissed(true)}
    />
  );
}

function HiredReceipt(props: {
  readonly name: string;
  readonly outfit: BlobOutfit;
  readonly blobId: string;
  readonly fresh: boolean;
}) {
  return (
    <div
      data-blob-card="proposal"
      data-proposal-state="hired"
      className={cn(
        "flex w-fit items-center gap-2 py-1 text-[13px] leading-5 text-foreground/85",
        props.fresh && "p2-rise",
      )}
      role="status"
    >
      <BlobAvatar
        outfit={props.outfit}
        state="idle"
        size={24}
        eyesFollowCursor={false}
        reaction={props.fresh ? "wave" : null}
        seed={props.blobId}
      />
      <span>
        <span className="font-medium">{props.name}</span> joined the team
      </span>
      <CheckIcon className="size-3.5 text-muted-foreground" aria-hidden />
    </div>
  );
}

function OpenProposal(props: {
  readonly view: ProposalView;
  readonly actions: ProposalActions;
  readonly onTweak?: (draft: BlobDraft, proposalId: string) => void;
  readonly onHired?: (profile: BlobProfile) => void;
  readonly flyIn: boolean;
  readonly onHiredLocal: (name: string, blobId: string) => void;
  readonly onDismissedLocal: () => void;
}) {
  const { view } = props;
  const { draft } = view;
  const labelOf = useEngineLabel();
  const suggested = useMemo(() => proposalOutfit(draft, view.cardId), [draft, view.cardId]);
  const deck = useMemo(() => lookDeck(suggested), [suggested]);
  const [look, setLook] = useState(0);
  const [customOutfit, setCustomOutfit] = useState<BlobOutfit | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [name, setName] = useState(draft.name);
  const [busy, setBusy] = useState<"hire" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nod, setNod] = useState(0);
  const avatarBox = useRef<HTMLDivElement>(null);

  const outfit = customOutfit ?? deck[look] ?? suggested;
  const cleanName = name.trim() || draft.name;
  const bullets = howItWorks(draft);
  const permission = PERMISSION_COPY[draft.permission];

  const cycle = useCallback(
    (direction: 1 | -1) => {
      setCustomOutfit(null);
      setLook((i) => stepLook(i, deck.length, direction));
      setNod((n) => n + 1);
    },
    [deck.length],
  );

  const edited = (): BlobDraft => ({
    ...draft,
    name: cleanName,
    outfit: fromAvatarOutfit(outfit),
  });

  const hire = async () => {
    setBusy("hire");
    setError(null);
    const from = rectOf(avatarBox.current);
    const result = await props.actions.hire(edited(), view.cardId);
    if (!result.ok) {
      setBusy(null);
      setError(result.message);
      return;
    }
    props.onHired?.(result.value);
    if (props.flyIn && from) {
      void flyToRoster(from, result.value.id, {
        name: result.value.name,
        outfit,
        onLand: landAndWave,
      });
    }
    props.onHiredLocal(result.value.name, result.value.id);
  };

  const dismiss = async () => {
    setBusy("dismiss");
    setError(null);
    const result: ApiResult<object> = await props.actions.dismiss(view.cardId);
    if (!result.ok) {
      setBusy(null);
      setError(result.message);
      return;
    }
    props.onDismissedLocal();
  };

  return (
    <section
      data-blob-card="proposal"
      data-proposal-state="open"
      data-proposal-version={view.version}
      aria-label={`Proposal: ${cleanName}`}
      className={cn(
        "w-full max-w-[34rem] rounded-2xl border border-border/70 bg-card p-4 sm:p-5",
        view.version > 1 && "p2-flash",
      )}
    >
      <div className="flex items-start gap-4">
        <div className="flex shrink-0 flex-col items-center gap-1.5">
          <div ref={avatarBox} className="grid size-24 place-items-center" data-proposal-avatar>
            <button
              type="button"
              onClick={() => cycle(1)}
              aria-label={`Try another look. Now: ${describeOutfit(outfit)}`}
              className="grid size-24 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <BlobAvatar
                outfit={outfit}
                state="idle"
                size={96}
                eyesFollowCursor={false}
                reaction={nod > 0 ? "nod" : null}
                reactionKey={nod}
                seed={view.cardId}
              />
            </button>
          </div>
          <div className="flex items-center gap-0.5" data-proposal-looks>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Previous look"
              onClick={() => cycle(-1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="More looks"
              aria-expanded={showPicker}
              onClick={() => setShowPicker((v) => !v)}
            >
              <ShuffleIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Next look"
              onClick={() => cycle(1)}
            >
              <ChevronRightIcon />
            </Button>
          </div>
          <p
            className="max-w-[7.5rem] text-center text-[10.5px] leading-3.5 text-muted-foreground/80"
            data-proposal-look-name
          >
            {describeOutfit(outfit)}
          </p>
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">
            <span>Suggested hire</span>
            {view.version > 1 ? (
              <Hint label="Kora revised this proposal">
                <span
                  className="rounded-full border border-border/70 px-1.5 py-px text-[10.5px] tracking-normal normal-case"
                  data-proposal-version-label
                >
                  v{view.version}
                </span>
              </Hint>
            ) : null}
          </div>
          <InlineName value={name} fallback={draft.name} onChange={setName} />
          {draft.title ? (
            <p className="text-[12.5px] leading-5 text-muted-foreground">{draft.title}</p>
          ) : null}
          {draft.job ? (
            <p className="mt-1.5 text-[13.5px] leading-5 text-foreground/90" data-proposal-job>
              {draft.job}
            </p>
          ) : null}
        </div>
      </div>

      {showPicker ? (
        <div
          className="mt-3 rounded-xl border border-border/60 bg-background/40 p-3"
          data-proposal-picker
        >
          <OutfitPicker
            value={outfit}
            onChange={(next) => setCustomOutfit(next)}
            previewState="idle"
          />
        </div>
      ) : null}

      {bullets.length > 0 ? (
        <div className="mt-4" data-proposal-how>
          <h4 className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">
            How it works
          </h4>
          <ul className="space-y-1.5">
            {bullets.map((b) => (
              <li key={b} className="flex gap-2 text-[13px] leading-5 text-foreground/85">
                <span
                  className="mt-[9px] size-1 shrink-0 rounded-full bg-muted-foreground/70"
                  aria-hidden
                />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <dl className="mt-4 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-[12.5px] leading-5">
        <dt className="text-muted-foreground">Model</dt>
        <dd className="text-foreground/90" data-proposal-model>
          {modelLabel(draft, labelOf)}
        </dd>
        <dt className="text-muted-foreground">Permission</dt>
        <Hint label={permission.hint}>
          <dd className="text-foreground/90" data-proposal-permission>
            {permission.label}
            <span className="text-muted-foreground"> · {permission.hint}</span>
          </dd>
        </Hint>
        {draft.apps.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Apps</dt>
            <dd className="flex flex-wrap gap-1.5" data-proposal-apps>
              {draft.apps.map((app) => (
                <ConnectChip key={app} app={app} />
              ))}
            </dd>
          </>
        ) : null}
        {draft.skills.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Skills</dt>
            <dd className="flex flex-wrap gap-1.5" data-proposal-skills>
              {draft.skills.map((skill) => (
                <span
                  key={skill}
                  className="rounded-full bg-foreground/[0.07] px-2 py-px text-[11.5px] text-foreground/80"
                >
                  {skill}
                </span>
              ))}
            </dd>
          </>
        ) : null}
        {draft.routines.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Routines</dt>
            <dd className="space-y-1" data-proposal-routines>
              {draft.routines.map((r) => (
                <div
                  key={`${r.title}|${r.cadence}`}
                  className="flex flex-wrap items-center gap-1.5 text-foreground/85"
                >
                  <span>{r.title}</span>
                  {r.cadence ? <span className="text-muted-foreground">· {r.cadence}</span> : null}
                  <span className="rounded-full border border-border/70 px-1.5 py-px text-[10.5px] text-muted-foreground">
                    Paused
                  </span>
                </div>
              ))}
            </dd>
          </>
        ) : null}
      </dl>

      {error ? (
        <p role="alert" className="mt-3 text-[12.5px] text-foreground/80" data-proposal-error>
          {error}
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy !== null} onClick={() => void hire()} data-proposal-hire>
          {busy === "hire" ? <Spinner className="size-3.5" /> : null}
          Hire {cleanName}
        </Button>
        {props.onTweak ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => props.onTweak?.(edited(), view.cardId)}
            data-proposal-tweak
          >
            Tweak
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost-muted"
          disabled={busy !== null}
          onClick={() => void dismiss()}
          data-proposal-dismiss
        >
          {busy === "dismiss" ? <Spinner className="size-3.5" /> : null}
          Not this
        </Button>
      </div>
    </section>
  );
}

/** The name, editable in place: click (or Enter on the focused name) to edit, Enter / blur to keep, Esc to undo. */
function InlineName(props: {
  readonly value: string;
  readonly fallback: string;
  readonly onChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(props.value);
  const commit = () => {
    const next = text.trim() || props.fallback;
    props.onChange(next);
    setText(next);
    setEditing(false);
  };
  if (editing) {
    return (
      <input
        autoFocus
        value={text}
        maxLength={NAME_MAX}
        aria-label="Blob name"
        data-proposal-name-input
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setText(props.value);
            setEditing(false);
          }
        }}
        className="-mx-1.5 w-[calc(100%+0.75rem)] rounded-lg border border-border bg-background px-1.5 py-0.5 text-[20px] font-semibold leading-7 tracking-[-0.02em] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        setText(props.value);
        setEditing(true);
      }}
      aria-label={`Name: ${props.value}. Edit`}
      data-proposal-name
      className="group/name -mx-1.5 flex max-w-full items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-left outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="truncate text-[20px] font-semibold leading-7 tracking-[-0.02em] text-foreground">
        {props.value}
      </span>
      <PencilIcon
        className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/name:opacity-100 group-focus-visible/name:opacity-100"
        aria-hidden
      />
    </button>
  );
}
