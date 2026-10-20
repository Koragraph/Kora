/** Navigates directly so the browser handles video playback and downloads, without fetching bytes. */

import { resolveProtocolRelativeMediaUrl } from "./mediaKinds";
import { Button } from "../ui/button";
import { resolveExternalWebLinkHost } from "../thread/externalLinkContextMenu";
import { ExternalLinkIcon, DownloadIcon } from "lucide-react";

export function OpenMediaLink(props: {
  readonly fileName?: string | undefined;
  readonly className?: string | undefined;
  readonly src?: string | null | undefined;
  readonly originalUrl?: string | undefined;
}) {
  const originalUrl =
    resolveExternalWebLinkHost(props.originalUrl) === null ? undefined : props.originalUrl;
  const source = originalUrl ?? props.src;
  if (!source) {
    return null;
  }
  const url = resolveProtocolRelativeMediaUrl(source);
  if (!URL.canParse(url)) {
    return null;
  }
  const protocol = new URL(url).protocol;
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "blob:") {
    return null;
  }
  const isBlob = protocol === "blob:";
  return (
    <Button
      render={
        <a
          download={isBlob ? props.fileName || true : undefined}
          target={isBlob ? undefined : "_blank"}
          rel="noopener noreferrer"
          href={url}
        />
      }
      className={props.className}
      variant="secondary"
      size="sm"
    >
      {isBlob ? <DownloadIcon /> : <ExternalLinkIcon />}
      {originalUrl ? "Open original" : isBlob ? "Download video" : "Open in browser"}
    </Button>
  );
}
