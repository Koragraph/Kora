import { promptFloatingLayerProps } from "./promptEventScope";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { type ZoomableImageHandle, ZoomableImage } from "./ZoomableImage";
import type { ExpandedImageView } from "./ExpandedImageView";
import { DialogPopup, DialogTitle, Dialog } from "../ui/dialog";
import { Button } from "../ui/button";
import { OpenMediaLink } from "../media/MediaLink";
import { MediaVideoPlayer } from "../media/VideoPlayer";
import { type MediaActionSource, MediaActions } from "../media/MediaMenu";
import { useCallback, useEffect, useState, useRef, memo } from "react";
import { ChevronRightIcon, ChevronLeftIcon, XIcon } from "lucide-react";

const MEDIA_VARS =
  "[--media-width:92vw] sm:[--media-width:calc(92vw-96px)] [--media-height:min(86vh,calc(100vh-160px))]";

const FAILED_PANEL =
  "flex h-48 w-[min(var(--media-width),512px)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white shadow-2xl";

function wrapIndex(index: number, count: number): number {
  return (((index % count) + count) % count) | 0;
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: {
  preview: ExpandedImageView;
  onClose: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [failedSources, setFailedSources] = useState<ReadonlySet<string>>(() => new Set());
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const zoomRef = useRef<ZoomableImageHandle | null>(null);
  const [restoreTarget] = useState<Element | null>(() =>
    typeof document === "undefined" ? null : document.activeElement,
  );

  const count = preview.images.length;
  const current = count === 0 ? 0 : wrapIndex(preview.index + offset, count);
  const item = preview.images[current];

  // Hand focus back to whatever opened the lightbox so the composer does not read the loss as a blur.
  useEffect(() => {
    return () => {
      if (restoreTarget instanceof HTMLElement && restoreTarget.isConnected) {
        restoreTarget.focus({ preventScroll: true });
      }
    };
  }, [restoreTarget]);

  const step = useCallback((delta: number) => setOffset((value) => value + delta), []);

  if (!item) return null;

  const isVideo = item.type === "video";
  const kind = isVideo ? "video" : "image";
  const baseSource: MediaActionSource = item.actionsSource ?? {
    kind,
    name: item.name || "Media",
    src: item.src,
  };
  const openFile = baseSource.onOpenFile;
  const source: MediaActionSource = openFile
    ? {
        ...baseSource,
        onOpenFile: () => {
          openFile();
          onClose();
        },
      }
    : baseSource;

  const failed = failedSources.has(item.src);
  const hasExternalOriginal = resolveExternalWebLinkHost(item.originalUrl) !== null;

  const media = isVideo ? (
    <MediaVideoPlayer
      {...(item.actionsSource ? { actionsSource: item.actionsSource } : {})}
      autoPlay={item.autoPlay ?? true}
      className="block text-center"
      key={`${current}:${item.src}`}
      label={item.name}
      {...(item.originalUrl ? { originalUrl: item.originalUrl } : {})}
      preload="metadata"
      src={item.src}
      stateClassName={FAILED_PANEL}
      style={{ maxHeight: "var(--media-height)", maxWidth: "var(--media-width)" }}
      videoClassName="rounded-lg border border-border/70 shadow-2xl"
    />
  ) : failed ? (
    <div className={FAILED_PANEL} role="alert">
      {hasExternalOriginal ? (
        <>
          <span>This image could not be loaded.</span>
          <OpenMediaLink fileName={item.name} originalUrl={item.originalUrl} src={item.src} />
        </>
      ) : (
        <span>Image unavailable. The file may have been moved or deleted.</span>
      )}
    </div>
  ) : (
    <ZoomableImage
      key={`${current}:${item.src}`}
      name={item.name}
      onError={() => setFailedSources((previous) => new Set(previous).add(item.src))}
      ref={zoomRef}
      src={item.src}
    />
  );

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogPopup
        backdropClassName="z-60"
        bottomStickOnMobile={false}
        className={`row-start-1 max-h-[92vh] w-[92vw] max-w-[92vw] items-center ${MEDIA_VARS}`}
        initialFocus={closeButtonRef}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          if (!isVideo && zoomRef.current?.pan(event.key)) {
            event.preventDefault();
            return;
          }
          if (count > 1) {
            event.preventDefault();
            step(event.key === "ArrowLeft" ? -1 : 1);
          }
        }}
        showCloseButton={false}
        variant="media"
        viewportClassName="z-60 grid-rows-1 place-items-center px-4 py-6 [-webkit-app-region:no-drag]"
        {...promptFloatingLayerProps}
      >
        <DialogTitle className="sr-only">
          {isVideo ? "Expanded video preview" : "Expanded image preview"}
        </DialogTitle>
        <div className="relative isolate z-10 max-h-[92vh] max-w-(--media-width)">
          <Button
            aria-label={isVideo ? "Close video preview" : "Close image preview"}
            className="absolute -top-10 right-0 z-20"
            variant="media-close"
            ref={closeButtonRef}
            onClick={onClose}
            size="icon-xs"
          >
            <XIcon />
          </Button>
          {count > 1 ? (
            <>
              <Button
                aria-label="Previous media"
                className="left-0 max-sm:top-auto max-sm:-bottom-12 max-sm:translate-y-0 rounded-full bg-white/10 sm:top-1/2"
                onClick={() => step(-1)}
                size="icon"
                variant="media-navigation"
              >
                <ChevronLeftIcon className="size-5" />
              </Button>
              <Button
                aria-label="Next media"
                className="right-0 max-sm:top-auto max-sm:-bottom-12 max-sm:translate-y-0 rounded-full bg-white/10 sm:top-1/2"
                onClick={() => step(1)}
                size="icon"
                variant="media-navigation"
              >
                <ChevronRightIcon className="size-5" />
              </Button>
            </>
          ) : null}
          <MediaActions source={source}>{media}</MediaActions>
          <div
            aria-atomic="true"
            aria-live="polite"
            className="mt-2 flex max-w-(--media-width) items-center justify-center gap-1.5 text-white/80 text-xs"
          >
            <span className="truncate">{item.name}</span>
            {count > 1 ? <span className="shrink-0">{`(${current + 1}/${count})`}</span> : null}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
});
