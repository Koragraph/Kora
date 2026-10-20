import { describe } from "@effect/vitest";

import { lintRule } from "../test/utils.ts";

const rule = lintRule("kora/no-slash-split-path");

describe("kora/no-slash-split-path", () => {
  rule.allows(
    "allows splitting model ids and URLs, and paths on a separator class",
    `
      declare const modelId: string;
      declare const url: string;
      declare const filePath: string;
      modelId.split("/");
      url.split("/");
      filePath.split(/[\\\\/]/);
    `,
  );

  rule.reports(
    "reports splitting a path on '/'",
    `
      declare const filePath: string;
      export const parts = filePath.split("/");
    `,
  );
});
