import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import type { ExpandedImageItem, ExpandedImageView } from "./ExpandedImageView";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaKinds";
import { mediaKindFromPath } from "@kora/shared/fileViewer";
import { mediaUrlReference } from "@kora/client-runtime/media/reference";

// Weak keys retain resolved media actions only while the rendered image is reachable.
export const markdownImageItems = new WeakMap<Element, ExpandedImageItem>();

/** Collect in document order only when opened, including PR sections separated by videos. */
export function markdownImageGallery(
  clicked: Element,
  selected: ExpandedImageItem,
): ExpandedImageView {
  const scope = clicked.closest("[data-image-gallery]") ?? clicked.closest(".reply-md");
  const clickedIsRegistered = markdownImageItems.has(clicked);
  let index = -1;
  const images: ExpandedImageItem[] = [];
  const candidates = scope?.querySelectorAll("img") ?? [];
  for (const image of candidates) {
    const registered = markdownImageItems.get(image);
    if (!registered) {
      continue;
    }
    const link = image.closest("a");
    const href = link?.getAttribute("href") ?? "";
    if (link && mediaKindFromPath(href) !== "image") {
      continue;
    }
    const linkedSource =
      resolveExternalWebLinkHost(href) === null ? null : resolveProtocolRelativeMediaUrl(href);
    let item: ExpandedImageItem = registered;
    if (linkedSource) {
      const reference = mediaUrlReference(href);
      const actionsSource = {
        ...(reference ? { reference } : {}),
        src: linkedSource,
        name: registered.name,
        kind: "image" as const,
      };
      item = { ...registered, actionsSource, originalUrl: href, src: linkedSource };
    }
    const isTheOpenedImage =
      image === clicked || (!clickedIsRegistered && index < 0 && item.src === selected.src);
    if (!isTheOpenedImage) {
      images.push(item);
      continue;
    }
    index = images.length;
    images.push(selected);
  }
  return index < 0 ? { index: 0, images: [selected] } : { index, images };
}
