import {
  type UploadMessageAttachment,
  AGENT_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  AGENT_SEND_TURN_MAX_UPLOAD_FILE_BYTES,
  AGENT_SEND_TURN_MAX_IMAGE_BYTES,
  AGENT_SEND_TURN_MAX_ATTACHMENTS,
} from "@kora/contracts";

import type { MessageAttachment } from "../types";

export interface PendingPromptAttachment {
  readonly dataUrl: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly name: string;
  readonly type: "image" | "file";
  readonly id: string;
}

const SUPPORTED_IMAGES: ReadonlySet<string> = new Set(
  AGENT_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.map((type) => type.toLowerCase()),
);

export function attachmentKindForMimeType(mediaType: string): "image" | "file" {
  return SUPPORTED_IMAGES.has(mediaType.toLowerCase()) ? "image" : "file";
}

export function formatAttachmentSize(buf: number): string {
  if (buf < 1024) return `${buf} B`;
  const units = ["KB", "MB", "GB"];
  let val = buf / 1024;
  let unitIndex = 0;
  while (val >= 1024 && unitIndex < units.length - 1) {
    val /= 1024;
    unitIndex += 1;
  }
  const shown = val >= 10 ? String(Math.round(val)) : String(Math.round(val * 10) / 10);
  return `${shown} ${units[unitIndex]}`;
}

export interface PromptAttachmentRejection {
  readonly name: string;
  readonly title: string;
  readonly description: string;
}

export interface PromptAttachmentIntake {
  readonly accepted: ReadonlyArray<File>;
  readonly rejections: ReadonlyArray<PromptAttachmentRejection>;
}

function overLimitRejection(name: string): PromptAttachmentRejection {
  return {
    name,
    title: `Can't attach ${name}`,
    description: `A message can carry at most ${AGENT_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
  };
}

/**
 * Caps attachments put back into the composer (Stop / queued-message / failed-send restores) at
 * the per-message limit, refusing the overflow with the same message as a fresh attach.
 */
export function capRestoredAttachments(
  attachments: ReadonlyArray<PendingPromptAttachment>,
  existingCount: number,
): { kept: PendingPromptAttachment[]; rejections: PromptAttachmentRejection[] } {
  const room = Math.max(0, AGENT_SEND_TURN_MAX_ATTACHMENTS - existingCount);
  return {
    kept: attachments.slice(0, room),
    rejections: attachments.slice(room).map((attachment) => overLimitRejection(attachment.name)),
  };
}

export function partitionIncomingAttachmentFiles(
  files: ReadonlyArray<File>,
  existingCount: number,
): PromptAttachmentIntake {
  const accepted: File[] = [];
  const rejections: PromptAttachmentRejection[] = [];
  let tally = existingCount;

  for (const fileRef of files) {
    const variant = attachmentKindForMimeType(fileRef.type);
    const limit =
      variant === "image" ? AGENT_SEND_TURN_MAX_IMAGE_BYTES : AGENT_SEND_TURN_MAX_UPLOAD_FILE_BYTES;
    const refuse = (heading: string, description: string) =>
      rejections.push({ name: fileRef.name, title: heading, description });

    if (tally >= AGENT_SEND_TURN_MAX_ATTACHMENTS) {
      rejections.push(overLimitRejection(fileRef.name));
    } else if (fileRef.size <= 0) {
      refuse(`Can't attach ${fileRef.name}`, "The file is empty.");
    } else if (fileRef.size > limit) {
      refuse(
        `${fileRef.name} is too large to attach`,
        `${variant === "image" ? "Images" : "Files"} over ${formatAttachmentSize(limit)} aren't supported.`,
      );
    } else {
      accepted.push(fileRef);
      tally += 1;
    }
  }
  return { accepted, rejections };
}

export function fileToPendingPromptAttachment(
  fileRef: File,
  id: string,
): Promise<PendingPromptAttachment> {
  return new Promise((resolve, fail) => {
    const reader = new FileReader();
    reader.onerror = () => fail(reader.error ?? new Error(`Failed to read ${fileRef.name}`));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        fail(new Error(`Failed to read ${fileRef.name}`));
        return;
      }
      resolve({
        id: id,
        type: attachmentKindForMimeType(fileRef.type),
        name: fileRef.name,
        mimeType: fileRef.type || "application/octet-stream",
        sizeBytes: fileRef.size,
        dataUrl: reader.result,
      });
    };
    reader.readAsDataURL(fileRef);
  });
}

export function pendingPromptAttachmentToUpload(
  attachment: PendingPromptAttachment,
): UploadMessageAttachment {
  const { type, id, name, mimeType, sizeBytes, dataUrl } = attachment;
  return { type, id, name, mimeType, sizeBytes, dataUrl } as UploadMessageAttachment;
}

/** The client id doubles as the attachment id: the server echoes it back onto the same row. */
export function pendingPromptAttachmentToOptimistic(
  attachment: PendingPromptAttachment,
): MessageAttachment {
  const { type, id, name, mimeType, sizeBytes, dataUrl } = attachment;
  return { type, id, name, mimeType, sizeBytes, previewUrl: dataUrl } as MessageAttachment;
}
