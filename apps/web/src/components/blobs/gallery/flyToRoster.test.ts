import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { arcKeyframes, createFlightController, type RectLike } from "./flyToRoster";
import { flightPoint } from "../../assistant/blobFlightPath";

const FROM: RectLike = { left: 400, top: 300, width: 64, height: 64 };
const ROW: RectLike = { left: 12, top: 120, width: 32, height: 32 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("flyToRoster", () => {
  it("resolves { landed: false } at once when no layer is mounted", async () => {
    const c = createFlightController({ findTarget: () => ROW });
    await expect(c.flyToRoster(FROM, "b1")).resolves.toEqual({ landed: false });
    expect(c.getFlights()).toHaveLength(0);
  });

  it("flies to the roster row and lands: onLand fires, the flight is removed", async () => {
    const c = createFlightController({ findTarget: (id) => (id === "b1" ? ROW : null) });
    c.registerLayer();
    const onLand = vi.fn();
    const done = c.flyToRoster(FROM, "b1", { name: "Popo", onLand });
    const [flight] = c.getFlights();
    expect(flight).toMatchObject({
      blobId: "b1",
      phase: "flying",
      to: ROW,
      from: FROM,
      name: "Popo",
    });
    c.finish(flight!.id);
    await expect(done).resolves.toEqual({ landed: true });
    expect(onLand).toHaveBeenCalledWith("b1");
    expect(c.getFlights()).toHaveLength(0);
  });

  it("waits for the roster row to appear (the snapshot lands a beat after the hire)", async () => {
    let present = false;
    const c = createFlightController({ findTarget: () => (present ? ROW : null) });
    c.registerLayer();
    const done = c.flyToRoster(FROM, "b2");
    expect(c.getFlights()[0]?.phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(300);
    expect(c.getFlights()[0]?.phase).toBe("waiting");
    present = true;
    await vi.advanceTimersByTimeAsync(120);
    const flight = c.getFlights()[0]!;
    expect(flight.phase).toBe("flying");
    c.finish(flight.id);
    await expect(done).resolves.toEqual({ landed: true });
  });

  it("falls back gracefully when the target never shows: the blob fades and the promise resolves landed:false", async () => {
    const onLand = vi.fn();
    const c = createFlightController({ findTarget: () => null });
    c.registerLayer();
    const done = c.flyToRoster(FROM, "ghost", { targetWaitMs: 500, onLand });
    await vi.advanceTimersByTimeAsync(700);
    const flight = c.getFlights()[0]!;
    expect(flight.phase).toBe("gone");
    c.finish(flight.id);
    await expect(done).resolves.toEqual({ landed: false });
    expect(onLand).not.toHaveBeenCalled();
  });

  it("settles pending flights when the last layer unmounts, so no caller waits forever", async () => {
    const c = createFlightController({ findTarget: () => null });
    const release = c.registerLayer();
    const done = c.flyToRoster(FROM, "b3");
    release();
    await expect(done).resolves.toEqual({ landed: false });
    expect(c.getFlights()).toHaveLength(0);
  });

  it("samples an arc that starts at the card and ends on the row, shrinking to the row's size", () => {
    const frames = arcKeyframes(FROM, ROW, flightPoint, 10);
    expect(frames).toHaveLength(11);
    expect(frames[0]).toMatchObject({ x: 432, y: 332, scale: 1, t: 0 });
    const last = frames.at(-1)!;
    expect(last.x).toBeCloseTo(28);
    expect(last.y).toBeCloseTo(136);
    expect(last.scale).toBeCloseTo(0.5);
    // The arc lifts above the straight line between the two centres.
    const mid = frames[5]!;
    expect(mid.y).toBeLessThan((332 + 136) / 2 - 40);
  });
});
