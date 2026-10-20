import { describe, expect, it } from "vite-plus/test";

import { defaultWorkerWindowFrame, maximizedWorkerWindowFrame } from "./workerWindowLayout";

describe("maximizedWorkerWindowFrame", () => {
  it("stays below the app's 52px title bar (an Electron drag strip that would swallow clicks)", () => {
    const frame = maximizedWorkerWindowFrame({ width: 1440, height: 900 });
    expect(frame.y).toBeGreaterThanOrEqual(52);
    expect(frame.y + frame.height).toBeLessThanOrEqual(900);
    expect(frame.x + frame.width).toBeLessThanOrEqual(1440);
  });
});

describe("defaultWorkerWindowFrame", () => {
  it("opens left of the sprite column, so the other sprites stay clickable", () => {
    const frame = defaultWorkerWindowFrame({ width: 1440, height: 900 });
    expect(frame.x + frame.width).toBeLessThanOrEqual(1440 - 64);
    expect(frame.x).toBeGreaterThanOrEqual(16);
  });
});
