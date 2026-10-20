import { describe, expect, it } from "vite-plus/test";

import { errorLogFields } from "./logFields.ts";

/** Everything the fields would print, joined into one searchable string. */
const printed = (fields: object) => Object.values(fields).map(String).join("\n");

describe("errorLogFields", () => {
  it("logs name, tag, trace id and a scrubbed stack, never a message", () => {
    const inner = new Error("INNER-PRIVATE");
    Object.assign(inner, { traceId: "trace-ok-77" });
    const outer = new Error("OUTER-PRIVATE", { cause: inner });
    Object.assign(outer, { _tag: "ProjectRemovalError" });
    outer.stack =
      "ProjectRemovalError: OUTER-PRIVATE\n" +
      "    at removeProject (https://ann:hunter2@host.test/p.ts?sig=abc#top)";

    const fields = errorLogFields(outer);

    expect(fields).toMatchObject({
      stack: "    at removeProject (https://host.test/p.ts)",
      traceId: "trace-ok-77",
      errorTag: "ProjectRemovalError",
      errorName: "Error",
      errorType: "error",
    });
    for (const leak of ["OUTER-PRIVATE", "INNER-PRIVATE", "ann:hunter2", "sig=abc"]) {
      expect(printed(fields)).not.toContain(leak);
    }
  });

  it("reports only the type of a plain object, whatever it claims", () => {
    const claims = {
      cause: { traceId: "has spaces so unsafe" },
      message: "PRIVATE-MESSAGE",
      _tag: "PRIVATE-TAG",
    };
    expect(errorLogFields(claims)).toEqual({ errorType: "object" });
  });

  it("falls through an unsafe trace id to a safe one in the cause", () => {
    const nested = { cause: { traceId: "inner-ok" }, traceId: "not safe" };
    expect(errorLogFields(nested)).toEqual({ traceId: "inner-ok", errorType: "object" });
  });
});
