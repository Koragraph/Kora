import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { OutputSeam } from "./output-seam.ts";

const make = () => {
  const out: string[] = [];
  return { out, seam: new OutputSeam((d) => out.push(d)) };
};

NodeTest.test(
  "OutputSeam: chunks fully inside the snapshot are dropped, later ones pass whole",
  () => {
    const { out, seam } = make();
    const t = seam.begin();
    seam.push("aaaa", 4);
    seam.push("bbbb", 8);
    seam.push("cccc", 12);
    seam.complete(t, 8, () => out.push("SNAP"));
    NodeAssert.deepEqual(out, ["SNAP", "cccc"]);
  },
);

NodeTest.test(
  "OutputSeam: a chunk straddling the snapshot offset is trimmed to the uncovered tail",
  () => {
    const { out, seam } = make();
    const t = seam.begin();
    seam.push("abcdef", 10);
    seam.complete(t, 7, () => {});
    NodeAssert.deepEqual(out, ["def"]);
  },
);

NodeTest.test("OutputSeam: with no open ticket live chunks flow straight through", () => {
  const { out, seam } = make();
  seam.push("live", 4);
  NodeAssert.deepEqual(out, ["live"]);
  const t = seam.begin();
  seam.push("late", 8);
  NodeAssert.deepEqual(out, ["live"]);
  seam.complete(t, 4, () => {});
  NodeAssert.deepEqual(out, ["live", "late"]);
});

NodeTest.test("OutputSeam: chunks without an offset are never dropped", () => {
  const { out, seam } = make();
  const t = seam.begin();
  seam.push("x", undefined);
  seam.complete(t, 1000, () => {});
  NodeAssert.deepEqual(out, ["x"]);
});

NodeTest.test(
  "OutputSeam: a resync overlapping the first snapshot loses nothing (the first snapshot completes first)",
  () => {
    const { out, seam } = make();
    const first = seam.begin();
    seam.push("aaaa", 4);
    const resync = seam.begin();
    seam.push("bbbb", 8);
    seam.complete(first, 4, () => out.push("S1"));
    seam.push("cccc", 12);
    NodeAssert.deepEqual(out, ["S1", "bbbb"], "live output stays held while the resync is pending");
    seam.complete(resync, 6, () => out.push("S2"));
    NodeAssert.deepEqual(out, ["S1", "bbbb", "S2", "bb", "cccc"]);
  },
);

NodeTest.test(
  "OutputSeam: a snapshot that finishes late is dropped once a newer one went out",
  () => {
    const { out, seam } = make();
    const slow = seam.begin();
    seam.push("aaaa", 4);
    const fast = seam.begin();
    seam.push("bbbb", 8);
    NodeAssert.equal(
      seam.complete(fast, 4, () => out.push("S-fast")),
      true,
    );
    NodeAssert.equal(seam.isOpen(slow), false);
    NodeAssert.equal(
      seam.complete(slow, 2, () => out.push("S-slow")),
      false,
    );
    seam.push("cccc", 12);
    NodeAssert.deepEqual(out, ["S-fast", "bbbb", "cccc"]);
  },
);

NodeTest.test("OutputSeam: completing the same ticket twice delivers once", () => {
  const { out, seam } = make();
  const t = seam.begin();
  seam.push("aaaa", 4);
  seam.complete(t, 0, () => out.push("S"));
  NodeAssert.equal(
    seam.complete(t, 0, () => out.push("S")),
    false,
  );
  NodeAssert.deepEqual(out, ["S", "aaaa"]);
});
