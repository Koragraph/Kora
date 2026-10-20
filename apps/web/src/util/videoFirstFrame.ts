type FirstFrameVideo = Pick<
  HTMLVideoElement,
  "src" | "seeking" | "played" | "paused" | "duration" | "currentTime" | "autoplay"
>;

/** True when the browser would already show a frame or the author asked for a specific one. */
function hasStartedOrIsUnseekable(video: FirstFrameVideo): boolean {
  const playbackStarted =
    video.autoplay || !video.paused || video.seeking || video.currentTime !== 0;
  const everPlayed = video.played.length > 0;
  const lengthUnknown = !Number.isFinite(video.duration) || video.duration <= 0;
  return playbackStarted || everPlayed || lengthUnknown;
}

/** Requests an initial frame without playing or replacing the video's streaming source. */
export function prepareVideoFirstFrame(video: FirstFrameVideo): void {
  if (hasStartedOrIsUnseekable(video)) return;

  const [, fragment] = video.src.split("#", 2);
  const asksForTimeFragment = Boolean(fragment) && new URLSearchParams(fragment).has("t");
  if (asksForTimeFragment) return;

  try {
    video.currentTime = Math.min(0.1, video.duration / 2);
  } catch {
    // A rejected preview seek must leave the native Play control usable.
  }
}
