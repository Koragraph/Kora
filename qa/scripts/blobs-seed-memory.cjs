#!/usr/bin/env node
"use strict";
// Seeds real memory rows (facts, one added receipt, one held-for-confirmation item) into an isolated QA stack's
// memory.db so the blobs.memory.* RPCs can be driven end to end without a model. No extractor model is called: the
// extractor is a script. Usage: node qa/scripts/blobs-seed-memory.cjs <KORA_HOME> <blobId>   (prints JSON)
const path = require("node:path");
const { openMemory } = require(path.resolve(__dirname, "../../packages/runtime/dist/memory/index.js"));

const [home, blobId] = process.argv.slice(2);
if (!home || !blobId) {
  console.error("usage: blobs-seed-memory.cjs <KORA_HOME> <blobId>");
  process.exit(2);
}
(async () => {
  const mem = openMemory({
    dbPath: path.join(home, "blobs", "memory.db"),
    extractor: async () =>
      JSON.stringify({
        ops: [
          { op: "add", scope: "you", text: "Prefers short answers.", confidence: 0.9 },
          { op: "add", scope: "you", text: "Has a rash on my left arm.", confidence: 0.9, sensitive: true },
        ],
      }),
  });
  const you = await mem.addFact({ scope: "you", text: "Lives in Dallas." });
  const mine = await mem.addFact({ scope: "blob", blobId, text: "Wants sources as a numbered list." });
  const out = await mem.ingestTurn({
    blobId,
    threadId: "seed-thread",
    userMessageId: "seed-u",
    assistantMessageId: "seed-a",
    userText: "I prefer short answers, and I have a rash on my left arm",
    assistantText: "Noted.",
    at: Date.now(),
  });
  const receipts = mem.listReceipts({ blobId, limit: 50 });
  console.log(JSON.stringify({ you: you.id, mine: mine.id, ingest: out, receipts, pending: mem.listPending({ blobId }) }));
  await mem.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
