import {
  type DiffsHighlighter,
  type SupportedLanguages,
  getSharedHighlighter,
  type HighlighterTypes,
} from "@pierre/diffs";

import { resolveDiffThemeName } from "./diffRendering";

/**
 * Always highlight with the Oniguruma WASM engine — the JS regex engine can
 * backtrack catastrophically and hang the tokenizing thread. The shared
 * highlighter is a first-caller-wins singleton, so every creation site must
 * pass this value.
 */
export const PREFERRED_HIGHLIGHTER: HighlighterTypes = "shiki-wasm";

type HighlighterPromise = Promise<DiffsHighlighter>;

const highlighterPromiseCache = new Map<string, HighlighterPromise>();

const FALLBACK_LANGUAGE = "text";

function startHighlighter(language: string): Promise<DiffsHighlighter> {
  return getSharedHighlighter({
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
    langs: [language as SupportedLanguages],
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
  });
}

export function getSyntaxHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached !== undefined) return cached;

  const pending = startHighlighter(language).catch((failure: unknown) => {
    if (language !== FALLBACK_LANGUAGE) {
      // Language not supported by Shiki — fall back to plain text
      return getSyntaxHighlighterPromise(FALLBACK_LANGUAGE);
    }
    // The fallback itself failed — Shiki cannot initialize at all, surface the error
    highlighterPromiseCache.delete(language);
    throw failure;
  });
  highlighterPromiseCache.set(language, pending);
  return pending;
}
