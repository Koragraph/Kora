import { describe, expect, it } from "vite-plus/test";

import { flightPoint } from "./blobFlightPath";

describe("flightPoint", () => {
  const start = { x: 0, y: 100 };
  const end = { x: 200, y: 300 };

  it("is exactly the start point at t=0", () => {
    expect(flightPoint(start, end, 0)).toEqual(start);
  });

  it("is exactly the end point at t=1", () => {
    expect(flightPoint(start, end, 1)).toEqual(end);
  });

  it("arcs above the straight line at the midpoint", () => {
    const straightMidY = (start.y + end.y) / 2;
    const mid = flightPoint(start, end, 0.5);
    expect(mid.y).toBeLessThan(straightMidY);
  });

  it("clamps t outside [0,1]", () => {
    expect(flightPoint(start, end, -1)).toEqual(start);
    expect(flightPoint(start, end, 2)).toEqual(end);
  });
});
