import { OpenMediaLink } from "./MediaLink";
import { type MediaActionSource, MediaActions } from "./MediaMenu";
import { Button } from "../ui/button";
import { prepareVideoFirstFrame } from "../../util/videoFirstFrame";
import { cn } from "../../util/utils";
import { type CSSProperties, useCallback, useEffect, useState, useRef } from "react";
import { TriangleAlertIcon, RotateCwIcon, PlayIcon } from "lucide-react";

interface PinnedSource {
  readonly src: string;
  readonly revision: string | null | undefined;
}

type WebkitVideo = HTMLVideoElement & { webkitDisplayingFullscreen?: boolean };

function inFullscreen(video: WebkitVideo): boolean {
  return (
    (document.fullscreenElement?.contains(video) ?? false) ||
    video.webkitDisplayingFullscreen === true
  );
}

export function MediaVideoPlayer(props: {
  readonly src: string | null;
  readonly label: string;
  readonly sourceFailed?: boolean;
  readonly originalUrl?: string;
  readonly revision?: string | null;
  readonly preload?: "visible" | "metadata";
  readonly autoPlay?: boolean;
  readonly onOpen?: () => void;
  readonly className?: string;
  readonly videoClassName?: string;
  readonly stateClassName?: string;
  readonly style?: CSSProperties;
  readonly copyMarkdown?: string;
  readonly onRetry?: () => Promise<unknown>;
  readonly actionsSource?: MediaActionSource;
}) {
  const { label, onOpen, onRetry, revision } = props;
  const preloadMode = props.preload ?? "visible";
  const thumbnail = onOpen !== undefined;
  const latestSrc = props.src;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const [pinned, setPinned] = useState<PinnedSource | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [preloadedSrc, setPreloadedSrc] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const src = pinned?.src ?? latestSrc;
  const failed = src !== null ? failedSrc === src : props.sourceFailed === true;

  // Playback keeps its pinned URL so a re-signed URL never resets the playhead; once idle, follow the newest.
  const releasePinIfIdle = useCallback(() => {
    const video = videoRef.current;
    const idle = !video || video.paused || video.ended;
    setPinned((current) => (current && idle && current.revision !== revision ? null : current));
  }, [revision]);

  useEffect(() => {
    releasePinIfIdle();
  }, [releasePinIfIdle]);

  useEffect(() => {
    if (preloadMode === "metadata" || src === null) return;
    if (preloadedSrc === src) return;
    const target = wrapperRef.current;
    if (!target || typeof IntersectionObserver === "undefined") {
      setPreloadedSrc(src);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          setPreloadedSrc(src);
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [preloadMode, src, preloadedSrc]);

  useEffect(() => {
    const video = videoRef.current as WebkitVideo | null;
    if (!video) return;
    const pauseWhenHidden = () => {
      if (document.hidden && !inFullscreen(video)) video.pause();
    };
    const documentEvents = ["fullscreenchange", "visibilitychange"] as const;
    for (const name of documentEvents) document.addEventListener(name, pauseWhenHidden);
    video.addEventListener("webkitendfullscreen", pauseWhenHidden);
    return () => {
      video.pause();
      video.removeEventListener("webkitendfullscreen", pauseWhenHidden);
      for (const name of documentEvents) document.removeEventListener(name, pauseWhenHidden);
    };
  }, [src, attempt]);

  const retry = async () => {
    if (retrying) {
      return;
    }
    setRetrying(true);
    try {
      await onRetry?.();
      setPinned(null);
      setFailedSrc(null);
      setAttempt((count) => count + 1);
    } catch {
      setFailedSrc(src);
    } finally {
      setRetrying(false);
    }
  };

  const stateBox = cn("block aspect-video w-full rounded-lg bg-muted/60", props.stateClassName);

  let body;
  if (failed && !thumbnail) {
    body = (
      <div
        className={cn(
          "flex aspect-video max-h-full min-h-28 w-full flex-col items-center justify-center gap-3 rounded-lg border border-border/40 bg-muted/40 p-4 text-center text-sm text-muted-foreground",
          props.stateClassName,
        )}
        role="alert"
      >
        <span className="inline-flex items-center gap-1.5">
          <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
          Video unavailable{label ? ` · ${label}` : ""}
        </span>
        {latestSrc !== null || onRetry ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" variant="secondary" disabled={retrying} onClick={() => void retry()}>
              <RotateCwIcon />
              {retrying ? "Retrying…" : "Retry video"}
            </Button>
            <OpenMediaLink
              originalUrl={props.originalUrl}
              src={latestSrc ?? src}
              fileName={label}
            />
          </div>
        ) : null}
      </div>
    );
  } else if (src === null || failed) {
    body = (
      <span
        role={thumbnail ? undefined : "status"}
        aria-label={thumbnail ? "Video preview unavailable" : "Loading video"}
        className={stateBox}
      />
    );
  } else {
    body = (
      <video
        key={`${src}:${attempt}`}
        ref={videoRef}
        src={src}
        aria-label={label || "Video preview"}
        aria-hidden={thumbnail ? true : undefined}
        controls={!thumbnail}
        muted={thumbnail}
        autoPlay={thumbnail ? false : props.autoPlay === true}
        playsInline
        preload={preloadMode === "metadata" || preloadedSrc === src ? "metadata" : "none"}
        className={cn(
          "aspect-video max-h-full w-full bg-black object-contain",
          thumbnail && "pointer-events-none",
          props.videoClassName,
        )}
        onLoadedMetadata={(event) => prepareVideoFirstFrame(event.currentTarget)}
        onPlay={(event) => {
          const current = event.currentTarget.currentSrc || src;
          setPinned((existing) => existing ?? { src: current, revision });
        }}
        onPause={releasePinIfIdle}
        onEnded={releasePinIfIdle}
        onError={() => {
          if (pinned && latestSrc !== null && latestSrc !== pinned.src) {
            setPinned(null);
            return;
          }
          setFailedSrc(src);
        }}
      />
    );
  }

  const content = (
    <span
      ref={wrapperRef}
      className={cn("relative inline-block align-middle", props.className)}
      style={props.style}
      data-markdown-copy={props.copyMarkdown}
    >
      {body}
      {thumbnail && !failed && src !== null ? (
        <button
          type="button"
          aria-label={label ? `Play ${label}` : "Play video"}
          className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          onClick={onOpen}
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-black/50 text-white">
            <PlayIcon className="size-4 fill-current" />
          </span>
        </button>
      ) : null}
    </span>
  );

  return props.actionsSource ? (
    <MediaActions source={props.actionsSource}>{content}</MediaActions>
  ) : (
    content
  );
}
