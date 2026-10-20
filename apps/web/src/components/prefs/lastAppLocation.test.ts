import { describe, expect, it } from "vite-plus/test";

import { lastAppLocation, rememberAppLocation } from "./lastAppLocation";

describe("lastAppLocation (where Settings' Back returns to)", () => {
  it("remembers the last app address", () => {
    rememberAppLocation("/kora-local/thread-1");
    expect(lastAppLocation()).toBe("/kora-local/thread-1");
  });

  it("never remembers a /projects/<key> redirect into Settings (Back would loop)", () => {
    rememberAppLocation("/draft/abc");
    rememberAppLocation("/projects/kora-local%3Aproject-1");
    expect(lastAppLocation()).toBe("/draft/abc");
  });
});
