import { describe, expect, test } from "vite-plus/test";

import { prepareVideoFirstFrame } from "./videoFirstFrame";

type Video = Parameters<typeof prepareVideoFirstFrame>[0];

const NEVER_PLAYED = { length: 0, start: () => 0, end: () => 0 };
const idle = (over: Partial<Video> = {}): Video => ({
  src: "https://host.test/v.mp4",
  duration: 5,
  currentTime: 0,
  played: NEVER_PLAYED,
  paused: true,
  seeking: false,
  autoplay: false,
  ...over,
});

/** A video whose currentTime setter records every seek. */
function recording(over: Partial<Video> = {}) {
  const seeks: number[] = [];
  const video = idle(over);
  Object.defineProperty(video, "currentTime", {
    get: () => seeks.at(-1) ?? over.currentTime ?? 0,
    set: (v: number) => void seeks.push(v),
  });
  return { video, seeks };
}

describe("prepareVideoFirstFrame", () => {
  test.each([
    [5, 0.1],
    [0.05, 0.025],
  ])("a %ss clip seeks to %ss, once even if metadata fires twice", (duration, target) => {
    const { video, seeks } = recording({ duration });
    prepareVideoFirstFrame(video);
    prepareVideoFirstFrame(video);
    expect(seeks).toEqual([target]);
  });

  test.each<[string, Partial<Video>]>([
    ["infinite duration", { duration: Infinity }],
    ["zero duration", { duration: 0 }],
    ["already played", { played: { length: 1, start: () => 0, end: () => 2 } }],
    ["mid-clip", { currentTime: 2 }],
    ["seeking", { seeking: true }],
    ["playing", { paused: false }],
    ["autoplay", { autoplay: true }],
  ])("does nothing when %s", (_label, state) => {
    const { video, seeks } = recording(state);
    prepareVideoFirstFrame(video);
    expect(seeks).toEqual([]);
  });

  test.each([
    ["a media fragment t=…", "v.mp4#t=0,4", false],
    ["a fragment with an encoded t key", "v.mp4#xywh=0,0,9,9&%74=3", false],
    ["an encoded # inside the file name", "v%23t=3.mp4", true],
    ["a fragment without t", "v.mp4#xywh=0,0,9,9", true],
  ])("%s", (_label, path, shouldSeek) => {
    const { video, seeks } = recording({ src: `https://host.test/${path}` });
    prepareVideoFirstFrame(video);
    expect(seeks.length).toBe(shouldSeek ? 1 : 0);
  });

  test("a browser that refuses the seek does not break the player", () => {
    const video = idle();
    Object.defineProperty(video, "currentTime", {
      get: () => 0,
      set: () => {
        throw new Error("not seekable");
      },
    });
    expect(() => prepareVideoFirstFrame(video)).not.toThrow();
  });
});
