// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- throwaway KORA_HOME + files for the thumbnail cache.
// First-page thumbnails of docx / pptx: made once per file version, cached, one at a time, never for anything else, and a
// renderer that is missing or gives up is just "no thumbnail" (the card keeps its text).
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-thumbs-"));
process.env.KORA_HOME = NodePath.join(tmp, "home");
const { blobThumbnail, THUMB_EXTENSIONS } = await import("./blobThumbs.ts");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const doc = (name: string, body = "x") => {
  const f = NodePath.join(tmp, name);
  NodeFS.writeFileSync(f, body);
  return f;
};
const dir = () => NodeFS.mkdtempSync(NodePath.join(tmp, "cache-"));

NodeTest.test(
  "a docx / pptx gets a PNG, made once per file version and then served from the cache",
  async () => {
    const d = dir();
    const calls: string[] = [];
    const run = async (file: string, out: string) => {
      calls.push(file);
      NodeFS.writeFileSync(NodePath.join(out, `${NodePath.basename(file)}.png`), PNG);
    };
    const f = doc("memo.docx");
    const a = await blobThumbnail(f, { run, dir: d });
    NodeAssert.ok(a && a.endsWith(".png") && NodeFS.readFileSync(a).equals(PNG));
    NodeAssert.equal(await blobThumbnail(f, { run, dir: d }), a);
    NodeAssert.equal(calls.length, 1, "the second ask is a cache hit");
    // the file changes (the blob edited it): a new version, a new thumbnail
    NodeFS.writeFileSync(f, "a longer body than before");
    const b = await blobThumbnail(f, { run, dir: d });
    NodeAssert.notEqual(b, a);
    NodeAssert.equal(calls.length, 2);
    NodeAssert.ok(await blobThumbnail(doc("deck.pptx"), { run, dir: d }));
    NodeAssert.deepEqual([...THUMB_EXTENSIONS].sort(), [".docx", ".pptx"]);
    NodeAssert.deepEqual(
      NodeFS.readdirSync(d).filter((n) => n.startsWith("work-")),
      [],
      "no work folders are left behind",
    );
  },
);

NodeTest.test(
  "not a docx / pptx, a missing file, a renderer that throws, hangs up or writes nothing: null, never an error",
  async () => {
    const d = dir();
    const never = async () => {
      throw new Error("must not run");
    };
    NodeAssert.equal(await blobThumbnail(doc("a.txt"), { run: never, dir: d }), null);
    NodeAssert.equal(await blobThumbnail(doc("b.xlsx"), { run: never, dir: d }), null);
    NodeAssert.equal(
      await blobThumbnail(NodePath.join(tmp, "missing.docx"), { run: never, dir: d }),
      null,
    );
    NodeAssert.equal(
      await blobThumbnail(doc("c.docx"), {
        run: async () => {
          throw new Error("boom");
        },
        dir: d,
      }),
      null,
    );
    NodeAssert.equal(
      await blobThumbnail(doc("d.docx"), { run: async () => undefined, dir: d }),
      null,
      "ran but made no PNG",
    );
    NodeAssert.equal(
      await blobThumbnail(doc("e.docx"), {
        run: async (_f, out) => {
          NodeFS.writeFileSync(NodePath.join(out, "e.png"), "");
        },
        dir: d,
      }),
      null,
      "an empty PNG is not a thumbnail",
    );
    // where macOS's own renderer is missing (and with the real runner) there is no thumbnail
    NodeAssert.equal(await blobThumbnail(doc("f.docx"), { hasRenderer: false, dir: d }), null);
    NodeAssert.deepEqual(
      NodeFS.readdirSync(d).filter((n) => n.startsWith("work-")),
      [],
    );
  },
);

NodeTest.test("concurrent asks share one job; different files run one at a time", async () => {
  const d = dir();
  let active = 0;
  let peak = 0;
  let calls = 0;
  const run = async (file: string, out: string) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 15));
    NodeFS.writeFileSync(NodePath.join(out, "x.png"), PNG);
    active--;
    void file;
  };
  const same = doc("same.docx");
  const results = await Promise.all([
    blobThumbnail(same, { run, dir: d }),
    blobThumbnail(same, { run, dir: d }),
    blobThumbnail(same, { run, dir: d }),
  ]);
  NodeAssert.equal(new Set(results).size, 1);
  NodeAssert.equal(calls, 1, "three cards for one file = one render");
  await Promise.all(
    ["p.docx", "q.docx", "r.pptx"].map((n) => blobThumbnail(doc(n), { run, dir: d })),
  );
  NodeAssert.equal(peak, 1, "never two Quick Look children at once");
});

NodeTest.test("the cache is bounded: old thumbnails are pruned", async () => {
  const d = dir();
  NodeFS.mkdirSync(d, { recursive: true });
  const old = NodePath.join(d, "old.png");
  NodeFS.writeFileSync(old, PNG);
  const past = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  NodeFS.utimesSync(old, past, past);
  await blobThumbnail(doc("fresh.docx"), {
    run: async (_f, out) => {
      NodeFS.writeFileSync(NodePath.join(out, "t.png"), PNG);
    },
    dir: d,
  });
  NodeAssert.equal(NodeFS.existsSync(old), false, "a thumbnail untouched for weeks is deleted");
});
