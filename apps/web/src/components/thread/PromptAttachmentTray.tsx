import { FileIcon, XIcon } from "lucide-react";
import { cn } from "~/util/utils";
import { formatAttachmentSize, type PendingPromptAttachment } from "../../util/promptAttachments";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Image thumbnails + file chips shown above the composer's text input while
 *  attachments are pending. Each entry is keyboard-removable via its × button. */
export function PromptAttachmentTray(props: {
  attachments: ReadonlyArray<PendingPromptAttachment>;
  onRemove: (attachmentId: string) => void;
}) {
  if (props.attachments.length === 0) return null;
  return (
    <div
      data-prompt-attachment-tray="true"
      className="mb-2 flex flex-wrap gap-1.5"
      role="list"
      aria-label="Attachments"
    >
      {props.attachments.map((attachment) =>
        attachment.type === "image" ? (
          <PromptAttachmentImage
            key={attachment.id}
            attachment={attachment}
            onRemove={props.onRemove}
          />
        ) : (
          <PromptAttachmentFileChip
            key={attachment.id}
            attachment={attachment}
            onRemove={props.onRemove}
          />
        ),
      )}
    </div>
  );
}

function RemoveAttachmentButton(props: { name: string; onRemove: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${props.name}`}
      onClick={props.onRemove}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full bg-background/80 text-muted-foreground transition-colors hover:bg-background hover:text-foreground",
        props.className,
      )}
    >
      <XIcon aria-hidden className="size-3" />
    </button>
  );
}

function PromptAttachmentImage(props: {
  attachment: PendingPromptAttachment;
  onRemove: (attachmentId: string) => void;
}) {
  const { attachment } = props;
  return (
    <div role="listitem" className="group relative size-14 shrink-0 overflow-hidden rounded-lg">
      <Tooltip>
        <TooltipTrigger
          render={
            <img
              src={attachment.dataUrl}
              alt={attachment.name}
              className="size-full rounded-lg border border-border/60 object-cover"
            />
          }
        />
        <TooltipPopup side="top">{attachment.name}</TooltipPopup>
      </Tooltip>
      <RemoveAttachmentButton
        name={attachment.name}
        onRemove={() => props.onRemove(attachment.id)}
        className="absolute top-1 right-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
      />
    </div>
  );
}

function PromptAttachmentFileChip(props: {
  attachment: PendingPromptAttachment;
  onRemove: (attachmentId: string) => void;
}) {
  const { attachment } = props;
  return (
    <div
      role="listitem"
      className="flex min-w-0 max-w-56 shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-foreground/5 py-1 pr-1 pl-2 text-xs"
    >
      <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-col leading-tight">
        <Tooltip>
          <TooltipTrigger
            render={<span className="truncate text-foreground">{attachment.name}</span>}
          />
          <TooltipPopup side="top">{attachment.name}</TooltipPopup>
        </Tooltip>
        <span className="text-muted-foreground tabular-nums">
          {formatAttachmentSize(attachment.sizeBytes)}
        </span>
      </div>
      <RemoveAttachmentButton
        name={attachment.name}
        onRemove={() => props.onRemove(attachment.id)}
        className="ml-auto bg-transparent hover:bg-foreground/10"
      />
    </div>
  );
}
