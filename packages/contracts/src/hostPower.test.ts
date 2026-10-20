import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ClientActivityClientId } from "./hostPower.ts";

const accepts = Schema.decodeUnknownOption(ClientActivityClientId);

describe("client activity client id", () => {
  it("trims surrounding whitespace", () => {
    expect(Option.getOrNull(accepts("\t desk-7 \n"))).toBe("desk-7");
  });

  it("allows up to 128 characters and no more", () => {
    const max = "k".repeat(128);
    expect(accepts(max)._tag).toBe("Some");
    expect(accepts(`${max}k`)._tag).toBe("None");
  });

  it("refuses a blank id", () => {
    expect(accepts(" \t ")._tag).toBe("None");
  });
});
