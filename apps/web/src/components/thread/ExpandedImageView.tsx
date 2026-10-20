import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaKinds";
import type { MediaActionSource } from "../media/MediaMenu";
import type { HostThreadRef } from "@kora/contracts";
import { resolveMediaSource } from "@kora/client-runtime/media/source";

export interface ExpandedImageItem {
  /** Authored remote destination to open when embedding fails. */
  originalUrl?: string;
  actionsSource?: MediaActionSource;
  srcFragment?: string;
  autoPlay?: boolean;
  type?: "video";
  name: string;
  src: string;
}

export interface ExpandedImageView {
  images: ExpandedImageItem[];
  index: number;
}

/**
 * Resolves a chat media reference to something the lightbox can show. Only media with a
 * direct URL (web images and videos) opens there; workspace files open in the Files panel.
 */
export function resolveMarkdownMediaPreview(input: {
  threadRef?: HostThreadRef | undefined;
  resolvedFilePath?: string | undefined;
  cwd?: string | undefined;
  source: string;
}): ExpandedImageView | null {
  const media = resolveMediaSource(input.source, {
    resolvedFilePath: input.resolvedFilePath,
    threadId: input.threadRef?.threadId,
    workspaceRoot: input.cwd,
  });
  if (media === null || media.access !== "direct") return null;
  const { kind, name, reference } = media;
  const src = resolveProtocolRelativeMediaUrl(media.uri);
  return {
    images: [
      {
        src,
        name,
        ...(kind === "video" ? { type: "video", autoPlay: false } : {}),
        ...(resolveExternalWebLinkHost(media.uri) !== null ? { originalUrl: media.uri } : {}),
        ...(media.srcFragment ? { srcFragment: media.srcFragment } : {}),
        actionsSource: { kind, name, src, ...(reference ? { reference } : {}) },
      },
    ],
    index: 0,
  };
}

export function expandedImageKey(preview: ExpandedImageView): string {
  return `${preview.images[preview.index]?.src ?? "image"}:${preview.index}`;
}
