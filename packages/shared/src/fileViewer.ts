import { videoMimeType } from "./videoFiles.ts";

export type FileViewerKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "html"
  | "markdown"
  | "text"
  | "unsupported";

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

// Audio is only for the file viewer. It is left out of mediaMimeType*, which feeds Markdown image/video embeds.
const AUDIO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".aiff": "audio/aiff",
};

const WORKSPACE_IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_BY_EXTENSION);

const withoutQueryOrHash = (path: string): string => path.split(/[?#]/, 1)[0] ?? "";

export function mediaMimeTypeFromExtension(extension: string): string | null {
  if (!/^\.[a-z0-9]+$/i.test(extension)) return null;
  const lower = extension.toLowerCase();
  return IMAGE_MIME_BY_EXTENSION[lower] ?? videoMimeType({ name: `media${lower}`, mimeType: "" });
}

const percentDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    // A literal % in a file name is not an escape.
    return value;
  }
};

export function mediaMimeType(path: string): string | null {
  let source = path.trim();
  if (source.startsWith("<") && source.endsWith(">")) source = source.slice(1, -1).trim();

  const dataUrl = /^data:((?:image|video)\/[^;,]+)/i.exec(source);
  if (dataUrl) return dataUrl[1]!.toLowerCase();

  let target = withoutQueryOrHash(source);
  if (/^(?:https?:|file:|\/\/)/i.test(source)) {
    try {
      target = new URL(source, "http://placeholder.invalid").pathname;
    } catch {
      return null;
    }
  }
  const decoded = percentDecode(target);
  const base = decoded.slice(Math.max(decoded.lastIndexOf("/"), decoded.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? null : mediaMimeTypeFromExtension(base.slice(dot));
}

export function mediaKindFromPath(path: string): "image" | "video" | null {
  const mime = mediaMimeType(path);
  if (mime === null) return null;
  return mime.startsWith("video/") ? "video" : "image";
}

// The file viewer is handed literal filesystem paths, so these never URL-decode.
export function isWorkspaceImageViewPath(path: string): boolean {
  const lower = withoutQueryOrHash(path).toLowerCase();
  return WORKSPACE_IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export const isWorkspaceVideoPreviewPath = (path: string): boolean =>
  videoMimeType({ name: path, mimeType: "" }) !== null;

export const isWorkspaceAudioPreviewPath = (path: string): boolean => {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return Object.hasOwn(AUDIO_MIME_BY_EXTENSION, path.slice(dot).toLowerCase());
};
