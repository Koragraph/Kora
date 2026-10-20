import type { ThreadId } from "@kora/contracts";
import { mediaMimeType, mediaMimeTypeFromExtension } from "@kora/shared/fileViewer";

import { classifyMarkdownImageSource, markdownImageSourceFragment } from "../markdown/images.ts";
import {
  type MediaReference,
  mediaUrlReference,
  mediaReferenceFileName,
  mediaFileReference,
} from "./reference.ts";

/** Asks the daemon to serve a file in place (the `media-file` asset resource). */
export type MediaSourceResource = {
  readonly _tag: "media-file";
  readonly threadId: ThreadId;
  readonly path: string;
};

export type ResolvedMediaSource = Readonly<Record<"name" | "mimeType" | "srcFragment", string>> & {
  readonly kind: "image" | "video";
  readonly reference?: MediaReference;
} & (
    | { readonly access: "direct"; readonly uri: string }
    | { readonly access: "environment"; readonly resource: MediaSourceResource }
    | { readonly access: "unavailable" }
  );

export interface ResolveMediaSourceInput {
  /** Image syntax may point at an endpoint with no recognisable extension. */
  readonly imageEmbed?: boolean | undefined;
  /** When given, the source is a known workspace file at this path. */
  readonly resolvedFilePath?: string | undefined;
  readonly workspaceRoot?: string | null | undefined;
  readonly threadId: ThreadId | undefined;
}

export const resolveMediaSource = (
  source: string,
  input: ResolveMediaSourceInput,
): ResolvedMediaSource | null => {
  const classified =
    input.resolvedFilePath === undefined
      ? classifyMarkdownImageSource(source, input.workspaceRoot)
      : ({ _tag: "WorkspaceFile", path: input.resolvedFilePath } as const);
  if (classified._tag === "Blocked") return null;

  // Local paths are already decoded, so `#`, `?` and `%` in them are literal.
  const filePath =
    classified._tag === "WorkspaceFile" ? classified.path.replace(/:\d+(?::\d+)?$/, "") : null;
  const mime =
    classified._tag === "Direct"
      ? mediaMimeType(classified.uri)
      : mediaMimeTypeFromExtension(/\.[^./\\]*$/.exec(basename(filePath!))?.[0] ?? "");
  const mimeType = mime ?? (input.imageEmbed ? "image/*" : null);
  if (mimeType == null) return null;
  const kind = /^video\//.test(mimeType) ? "video" : "image";

  const reference =
    classified._tag !== "Direct"
      ? mediaFileReference(filePath!, input.workspaceRoot)
      : mediaUrlReference(classified.uri);
  const name =
    (reference ? mediaReferenceFileName(reference) : undefined) ??
    (filePath === null ? undefined : basename(filePath)) ??
    kind;

  const base = {
    kind,
    mimeType,
    name: name || kind,
    ...(reference === undefined ? {} : { reference }),
    srcFragment: markdownImageSourceFragment(source),
  } as const;

  if (classified._tag === "Direct") return { ...base, access: "direct", uri: classified.uri };
  if (input.threadId === undefined) return { ...base, access: "unavailable" };
  return {
    ...base,
    access: "environment",
    resource: { _tag: "media-file", threadId: input.threadId, path: filePath! },
  };
};

const basename = (path: string): string =>
  path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
