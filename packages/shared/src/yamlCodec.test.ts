import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { fromYamlString } from "./yamlCodec.ts";

describe("YAML transformation", () => {
  it("plugs straight into Schema.decodeTo", () => {
    const yaml = Schema.decodeUnknownSync(
      Schema.String.pipe(Schema.decodeTo(Schema.Unknown, fromYamlString)),
    );
    expect(yaml("name: kora\nports:\n  - 80\n  - 443\n")).toEqual({
      name: "kora",
      ports: [80, 443],
    });
  });
});
