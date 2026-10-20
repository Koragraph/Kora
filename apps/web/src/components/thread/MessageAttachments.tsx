import { cn } from "~/util/utils";
import { useHostHttpBaseUrl } from "~/atoms/hosts";
import { formatAttachmentSize } from "../../util/promptAttachments";
import { useAttachmentBlobUrl, downloadAttachment } from "../../util/attachmentBlobUrl";
import type { MessageAttachment } from "../../types";
import type { ThreadId, HostId } from "@kora/contracts";
import { useState } from "react";
import { FileIcon, XIcon } from "lucide-react";

// `ChatUnknownAttachment["type"]` is a plain `string` (any discriminator a
// newer build might introduce), which keeps automatic narrowing from working
// on `attachment.type === "image"` alone — it can't rule out the unknown
// branch. Explicit predicates sidestep that.
function isImageAttachment(
  attachment: MessageAttachment,
): attachment is Extract<MessageAttachment, { type: "image" }> {
  return attachment.type === "image";
}
function isFileAttachment(
  attachment: MessageAttachment,
): attachment is Extract<MessageAttachment, { type: "file" }> {
  return attachment.type === "file";
}
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Renders a user message's attachments: image thumbnails (click to expand) and file chips
 *  (click to download the authed blob). An attachment type this build doesn't know
 *  renders as a plain, inert chip. */
export function MessageAttachments(props: {
  attachments: ReadonlyArray<MessageAttachment>;
  hostId: HostId;
  threadId: ThreadId | null;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const httpBaseUrl = useHostHttpBaseUrl(props.hostId);
  if (props.attachments.length === 0) return null;
  const expanded = props.attachments.find(
    (attachment): attachment is Extract<MessageAttachment, { type: "image" }> =>
      isImageAttachment(attachment) && attachment.id === expandedId,
  );
  return (
    <div className="mt-1.5 flex flex-wrap justify-end gap-1.5" role="list" aria-label="Attachments">
      {props.attachments.map((attachment) =>
        isImageAttachment(attachment) ? (
          <AttachmentImageThumbnail
            key={attachment.id}
            attachment={attachment}
            httpBaseUrl={httpBaseUrl}
            threadId={props.threadId}
            onExpand={() => setExpandedId(attachment.id)}
          />
        ) : isFileAttachment(attachment) ? (
          <AttachmentFileChip
            key={attachment.id}
            attachment={attachment}
            httpBaseUrl={httpBaseUrl}
            threadId={props.threadId}
          />
        ) : (
          <div
            key={attachment.id}
            role="listitem"
            className="rounded-lg border border-border/60 bg-foreground/5 px-2 py-1 text-xs text-muted-foreground"
          >
            {attachment.name}
          </div>
        ),
      )}
      {expanded ? (
        <AttachmentImageLightbox
          name={expanded.name}
          httpBaseUrl={httpBaseUrl}
          threadId={props.threadId}
          attachmentId={expanded.id}
          previewUrl={expanded.previewUrl}
          onClose={() => setExpandedId(null)}
        />
      ) : null}
    </div>
  );
}

function AttachmentImageThumbnail(props: {
  attachment: Extract<MessageAttachment, { type: "image" }>;
  httpBaseUrl: string | null;
  threadId: ThreadId | null;
  onExpand: () => void;
}) {
  const localPreview = "previewUrl" in props.attachment ? props.attachment.previewUrl : undefined;
  const fetched = useAttachmentBlobUrl(
    localPreview ? null : props.httpBaseUrl,
    props.threadId,
    props.attachment.id,
  );
  const src = localPreview ?? fetched.url;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            role="listitem"
            onClick={props.onExpand}
            disabled={!src}
            aria-label={`Open image ${props.attachment.name}`}
            className="size-14 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-foreground/5 disabled:cursor-default"
          >
            {src ? (
              <img src={src} alt={props.attachment.name} className="size-full object-cover" />
            ) : null}
          </button>
        }
      />
      <TooltipPopup side="top">{props.attachment.name}</TooltipPopup>
    </Tooltip>
  );
}

function AttachmentImageLightbox(props: {
  name: string;
  httpBaseUrl: string | null;
  threadId: ThreadId | null;
  attachmentId: string;
  previewUrl: string | undefined;
  onClose: () => void;
}) {
  const fetched = useAttachmentBlobUrl(
    props.previewUrl ? null : props.httpBaseUrl,
    props.threadId,
    props.attachmentId,
  );
  const src = props.previewUrl ?? fetched.url;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup
        variant="media"
        showCloseButton={false}
        viewportClassName="z-[60] grid-rows-1 place-items-center px-4 py-6"
        className="row-start-1 max-h-[92vh] w-[92vw] max-w-[92vw] items-center overflow-visible"
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}
      >
        <DialogTitle className="sr-only">Expanded image: {props.name}</DialogTitle>
        <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
          <Button
            className="absolute right-0 -top-10 z-20"
            aria-label="Close image preview"
            onClick={props.onClose}
            variant="media-close"
            size="icon-xs"
            type="button"
          >
            <XIcon />
          </Button>
          {src ? (
            <img
              src={src}
              alt={props.name}
              className="max-h-[86vh] max-w-[92vw] rounded-lg border border-border/70 object-contain shadow-2xl"
            />
          ) : (
            <div className="flex h-48 w-96 items-center justify-center rounded-lg border border-border/70 bg-black text-sm text-white">
              Loading image…
            </div>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function AttachmentFileChip(props: {
  attachment: Extract<MessageAttachment, { type: "file" }>;
  httpBaseUrl: string | null;
  threadId: ThreadId | null;
}) {
  const { attachment } = props;
  const download = async () => {
    if (!props.httpBaseUrl || !props.threadId) return;
    const saved = await downloadAttachment(
      props.httpBaseUrl,
      props.threadId,
      attachment.id,
      attachment.name,
    ).catch(() => false);
    if (!saved) {
      toastManager.add({
        type: "error",
        title: `Couldn't download ${attachment.name}`,
        description: "The file could not be fetched from Kora. Try again.",
      });
    }
  };
  return (
    <button
      type="button"
      role="listitem"
      onClick={() => void download()}
      disabled={!props.httpBaseUrl || !props.threadId}
      className={cn(
        "flex min-w-0 max-w-56 shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-foreground/5 py-1 pr-2 pl-2 text-xs transition-colors hover:bg-foreground/10",
        "disabled:cursor-default disabled:opacity-70",
      )}
    >
      <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-col items-start leading-tight">
        <Tooltip>
          <TooltipTrigger
            render={<span className="max-w-full truncate text-foreground">{attachment.name}</span>}
          />
          <TooltipPopup side="top">{attachment.name}</TooltipPopup>
        </Tooltip>
        <span className="text-muted-foreground tabular-nums">
          {formatAttachmentSize(attachment.sizeBytes)}
        </span>
      </div>
    </button>
  );
}
