// The "hybrid skin" a blob thread's transcript wears: messenger bubbles + the blob's avatar for the conversation,
// Kora rows for tool activity. ThreadView provides it (null outside Blobs); the transcript reads it with
// `useBlobSkin()`. A context instead of a prop so the transcript can adopt it without touching ThreadView again.
import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";

import type { BlobOutfit } from "~/components/blobs/avatar";
import { useBlobRoster } from "../shell/useBlobRoster";

export interface BlobSkin {
  readonly blobId: string;
  readonly name: string;
  readonly title: string;
  readonly outfit: BlobOutfit;
  readonly chief: boolean;
}

const BlobSkinContext = createContext<BlobSkin | null>(null);

export function BlobSkinProvider(props: { skin: BlobSkin | null; children: ReactNode }) {
  return createElement(BlobSkinContext.Provider, { value: props.skin }, props.children);
}

/** The active thread's blob skin, or null for Chat and Code threads. */
export function useBlobSkin(): BlobSkin | null {
  return useContext(BlobSkinContext);
}

/** Builds the skin for a blob id (null id or unknown blob = no skin). Stable across unrelated roster updates. */
export function useBlobSkinFor(blobId: string | null): BlobSkin | null {
  const { entries } = useBlobRoster();
  const entry = blobId ? entries.get(blobId) : undefined;
  const name = entry?.blob.name;
  const title = entry?.blob.title;
  const chief = entry?.chief;
  const outfit = entry?.outfit;
  const id = entry?.blob.id;
  return useMemo(
    () =>
      id !== undefined && name !== undefined && outfit !== undefined
        ? { blobId: id, name, title: title ?? "", outfit, chief: chief === true }
        : null,
    // The outfit object is rebuilt per roster tick; key on its slots so the skin stays referentially stable.
    [id, name, title, chief, outfit?.head, outfit?.face],
  );
}
