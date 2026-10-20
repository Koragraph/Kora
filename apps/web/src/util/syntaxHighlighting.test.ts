import type { DiffsHighlighter } from "@pierre/diffs";
import { expect, test, vi } from "vite-plus/test";

const shared = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@pierre/diffs", () => ({ getSharedHighlighter: shared.load }));

import { getSyntaxHighlighterPromise } from "./syntaxHighlighting";

test("an unsupported language falls back to the text highlighter, and the result is cached", async () => {
  const fallback = {} as DiffsHighlighter;
  shared.load.mockImplementation(({ langs }: { langs: string[] }) =>
    langs[0] === "text" ? Promise.resolve(fallback) : Promise.reject(new Error("no grammar")),
  );

  const a = getSyntaxHighlighterPromise("made-up-lang");
  await expect(a).resolves.toBe(fallback);

  expect(getSyntaxHighlighterPromise("made-up-lang")).toBe(a);
  expect(shared.load).toHaveBeenCalledTimes(2);
});
