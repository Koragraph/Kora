import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";

import { looksLikePlan } from "./planText.ts";

NodeTest.test("a plan has structure; a question back or a plain answer does not", () => {
  NodeAssert.equal(looksLikePlan("## Plan\n1. Add the flag\n2. Wire it\n3. Test"), true);
  NodeAssert.equal(looksLikePlan("Here is how:\n- change `a.ts`\n- update the caller"), true);
  NodeAssert.equal(looksLikePlan("Which database do you want it in?"), false);
  NodeAssert.equal(
    looksLikePlan("Two options:\n- SQLite\n- Postgres\nWhich one do you prefer?"),
    false,
  );
  NodeAssert.equal(looksLikePlan("It already works that way, no change needed."), false);
  NodeAssert.equal(looksLikePlan("   "), false);
  const long = `# Plan\n${"- step with detail\n".repeat(40)}Does that sound right?`;
  NodeAssert.equal(looksLikePlan(long), true, "a long plan that ends politely is still a plan");
});
