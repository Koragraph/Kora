import { GENERIC_MIME_TYPES } from "./imageMime.ts";

const VIDEO_TYPES: Record<string, string> = {
  avi: "video/x-msvideo",
  m4v: "video/mp4",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  ogv: "video/ogg",
  webm: "video/webm",
};

export const VIDEO_FILE_EXTENSIONS = Object.freeze(Object.keys(VIDEO_TYPES));

function extensionOf(fileName: string): string | null {
  const at = fileName.lastIndexOf(".");
  return at === -1 ? null : fileName.slice(at + 1).toLowerCase();
}

/** Recognizes videos even when the file picker omitted their MIME type. */
type NamedAttachment = { readonly mimeType: string; readonly name: string };

export function videoMimeType(attachment: NamedAttachment): string | null {
  const declared = (attachment.mimeType.split(";", 1)[0] ?? "").trim().toLowerCase();
  if (declared.startsWith("video/")) return declared;
  // The name is only evidence when nothing recorded what this is. A definite type already
  // answers the question, and a `.mp4` on a PDF must not override it.
  if (declared && !GENERIC_MIME_TYPES.has(declared)) return null;
  const ext = extensionOf(attachment.name);
  return ext !== null && Object.hasOwn(VIDEO_TYPES, ext) ? VIDEO_TYPES[ext]! : null;
}
