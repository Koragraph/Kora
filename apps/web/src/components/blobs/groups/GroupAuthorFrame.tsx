// The group transcript's version of BlobAssistantFrame: the same avatar gutter and bubble, plus the author's name (and
// title, and a Chief mark) above the first bubble of a burst. Drop-in: the transcript renders this instead of
// BlobAssistantFrame when the thread is a group thread, passing the row's author.
import type { ReactNode } from "react";

import { cn } from "~/util/utils";
import type { BlobSkin } from "../chat/blobSkin";
import { BlobAssistantFrame } from "../transcript/BlobBubbles";
import type { BubblePosition } from "../transcript/grouping";

function AuthorName(props: {
  readonly skin: BlobSkin;
  readonly lead?: boolean;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-0.5 flex min-w-0 items-baseline gap-1.5 pl-1 text-[12px] leading-none",
        props.className,
      )}
      data-group-author={props.skin.blobId}
    >
      <span className="truncate font-semibold text-foreground">{props.skin.name}</span>
      {props.skin.chief ? (
        <span className="shrink-0 rounded-full bg-foreground/90 px-1.5 py-px text-[8.5px] font-semibold tracking-wide text-background uppercase">
          Chief
        </span>
      ) : props.skin.title ? (
        <span className="truncate text-muted-foreground max-sm:hidden">{props.skin.title}</span>
      ) : null}
      {props.lead ? (
        <span className="shrink-0 text-[10.5px] text-muted-foreground">lead</span>
      ) : null}
    </div>
  );
}

export function GroupAssistantFrame(props: {
  readonly skin: BlobSkin;
  readonly position: BubblePosition | undefined;
  readonly lead?: boolean;
  readonly children: ReactNode;
}) {
  const first = props.position?.first ?? true;
  return (
    <BlobAssistantFrame skin={props.skin} position={props.position}>
      {first ? (
        <AuthorName skin={props.skin} {...(props.lead !== undefined ? { lead: props.lead } : {})} />
      ) : null}
      {props.children}
    </BlobAssistantFrame>
  );
}
