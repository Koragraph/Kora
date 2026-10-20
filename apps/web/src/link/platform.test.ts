import {
  primaryRegistrationToRetainAfterTopologyRead,
  readPrimaryHostTargetResult,
} from "./platform.ts";
import { describe, expect, it } from "@effect/vitest";
import { PRIMARY_LOCAL_HOST_ID } from "@kora/contracts";

describe("primary topology cache", () => {
  const registration = {} as never;
  const cached = {
    registration,
    signature: "primary|http://127.0.0.1:3773/|ws://127.0.0.1:3773/",
  };
  const previous = new Map([[PRIMARY_LOCAL_HOST_ID, cached]]);

  it("treats a successful primary absence as authoritative removal", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        target: null,
        _tag: "Success",
      }),
    ).toBeUndefined();
  });

  it("retains the cached primary after a transient topology read failure", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        cause: new Error("IPC unavailable"),
        _tag: "Failure",
      }),
    ).toBe(cached);
  });

  it("captures synchronous primary target read failures", () => {
    const cause = new Error("invalid primary target");

    expect(
      readPrimaryHostTargetResult(() => {
        throw cause;
      }),
    ).toEqual({ _tag: "Failure", cause });
  });
});
