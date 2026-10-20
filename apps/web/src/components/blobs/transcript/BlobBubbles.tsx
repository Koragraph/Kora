// The Blobs transcript skin, as small wrappers ThreadTranscript drops around its existing rows. Each is a no-op
// pass-through when `skin` is null (Chat and Code), so those surfaces render exactly as before.
//
//   BlobAssistantFrame  avatar gutter + column around an assistant reply (avatar on the first reply of a burst)
//   BlobBubble          the bubble around the reply's markdown
//   BlobMessageMeta     time, copy and the "show steps" toggle under a settled reply, on hover
//   BlobTypingRow       the blob's thinking animation while a turn has not produced text yet
import { ListTreeIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { BlobAvatar, type BlobVisualState } from "~/components/blobs/avatar";
import { cn } from "~/util/utils";
import type { BlobSkin } from "../chat/blobSkin";
import type { BubblePosition } from "./grouping";
import { BLOB_AVATAR_SIZE, BLOB_GUTTER_PX, bubbleShapeClassName } from "./skinClasses";
import "./blobTranscript.css";

/** How long the avatar holds its "done" face after the last token. */
const BLOB_DONE_FACE_MS = 1800;

/**
 * `talking` while any reply of the burst streams, `done` for a moment after it stops, else `idle`. The done face
 * only plays on a live transition: a reply that was already finished when the row mounted stays idle.
 */
function useBlobAvatarState(streaming: boolean): BlobVisualState {
  const previous = useRef(streaming);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const was = previous.current;
    previous.current = streaming;
    if (!was || streaming) {
      if (streaming) setDone(false);
      return;
    }
    setDone(true);
    const timer = setTimeout(() => setDone(false), BLOB_DONE_FACE_MS);
    return () => clearTimeout(timer);
  }, [streaming]);
  return streaming ? "talking" : done ? "done" : "idle";
}

function SkinAvatar({ skin, state }: { skin: BlobSkin; state: BlobVisualState }) {
  return (
    <BlobAvatar
      size={BLOB_AVATAR_SIZE}
      outfit={skin.outfit}
      chief={skin.chief}
      chiefScale={1}
      state={state}
      label={skin.name}
    />
  );
}

function AvatarGutter({
  skin,
  show,
  state,
}: {
  skin: BlobSkin;
  show: boolean;
  state: BlobVisualState;
}) {
  return (
    <div
      className="shrink-0 pt-0.5"
      style={{ width: BLOB_GUTTER_PX }}
      data-blob-gutter={show ? "avatar" : "spacer"}
    >
      {show ? <SkinAvatar skin={skin} state={state} /> : null}
    </div>
  );
}

function FramedAvatar({
  skin,
  position,
}: {
  skin: BlobSkin;
  position: BubblePosition | undefined;
}) {
  const state = useBlobAvatarState(position?.streaming ?? false);
  return <AvatarGutter skin={skin} show state={state} />;
}

export function BlobAssistantFrame(props: {
  readonly skin: BlobSkin | null;
  readonly position: BubblePosition | undefined;
  readonly children: ReactNode;
}) {
  const { skin, position } = props;
  if (skin === null) return <>{props.children}</>;
  const first = position?.first ?? true;
  return (
    <div className="flex items-start gap-2.5" data-blob-row="assistant" data-blob-first={first}>
      {first ? (
        <FramedAvatar skin={skin} position={position} />
      ) : (
        <AvatarGutter skin={skin} show={false} state="idle" />
      )}
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

export function BlobBubble(props: {
  readonly skin: BlobSkin | null;
  readonly position: BubblePosition | undefined;
  readonly children: ReactNode;
}) {
  if (props.skin === null) return <>{props.children}</>;
  return (
    <div
      data-blob-bubble="assistant"
      className={cn(
        "relative w-fit min-w-0 max-w-full bg-card lift-none dark:bg-(--bubble-assistant) px-3.5 py-2 text-foreground ring-1 ring-border/50 sm:max-w-[min(100%,40rem)]",
        bubbleShapeClassName("left", props.position),
      )}
    >
      {props.children}
    </div>
  );
}

export function BlobMessageMeta(props: {
  readonly skin: BlobSkin;
  /** Visible at rest (the latest settled reply); other replies show it on hover. */
  readonly resting: boolean;
  readonly time: ReactNode;
  readonly copy: ReactNode;
  readonly onToggleSteps: (() => void) | null;
  readonly className?: string;
}) {
  return (
    <div
      data-blob-meta
      className={cn(
        "flex items-center gap-1.5 pl-1 text-[11px] tabular-nums transition-opacity duration-200",
        props.resting
          ? "opacity-100"
          : "opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100",
        props.className,
      )}
    >
      {props.time}
      {props.copy}
      {props.onToggleSteps ? (
        <button
          type="button"
          data-scroll-anchor-ignore
          aria-label={`Show what ${props.skin.name} did`}
          onClick={props.onToggleSteps}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
        >
          <ListTreeIcon className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/** The wait before the first token: the blob's thinking animation beside three quiet dots. */
export function BlobTypingRow(props: { readonly skin: BlobSkin; readonly label?: string | null }) {
  return (
    <div className="flex items-center gap-2.5" data-blob-typing>
      <AvatarGutter skin={props.skin} show state="thinking" />
      <div
        role="status"
        aria-label={`${props.skin.name} is thinking`}
        className="flex h-[26px] items-center gap-2 rounded-full bg-card px-3 ring-1 ring-border/50"
      >
        <span className="flex items-center gap-1" aria-hidden>
          <span className="blob-typing-dot" />
          <span className="blob-typing-dot" />
          <span className="blob-typing-dot" />
        </span>
        {props.label ? (
          <span className="text-[12px] text-muted-foreground">{props.label}</span>
        ) : null}
      </div>
    </div>
  );
}
