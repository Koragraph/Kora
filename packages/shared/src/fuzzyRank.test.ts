import { describe, expect, it } from "vite-plus/test";

import * as ranking from "./fuzzyRank.ts";

const { normalizeSearchQuery, scoreQueryMatch, scoreSubsequenceMatch } = ranking;

const tiers = { exactBase: 0, prefixBase: 100, boundaryBase: 200, includesBase: 300 } as const;

const score = (
  value: string,
  query: string,
  extra: Partial<Parameters<typeof scoreQueryMatch>[0]> = {},
) => scoreQueryMatch({ ...tiers, value, query, ...extra });

describe("search ranking", () => {
  describe("query normalization", () => {
    it("strips surrounding whitespace and lowercases", () => {
      expect(normalizeSearchQuery("\t Deploy ")).toBe("deploy");
      expect(normalizeSearchQuery("   ")).toBe("");
    });

    it("drops a leading trigger matched by the caller's pattern", () => {
      expect(normalizeSearchQuery(" @@Deploy", { trimLeadingPattern: /^@+/ })).toBe("deploy");
    });
  });

  describe("tiered query scores", () => {
    it("returns the exact base for an exact hit and something worse otherwise", () => {
      expect(score("deploy", "deploy")).toBe(0);
      const loose = score("run the deploy", "deploy");
      expect(loose).not.toBeNull();
      expect(loose!).toBeGreaterThan(0);
    });

    it("ranks a hit after a boundary marker ahead of a mid-word hit", () => {
      const markers = { boundaryMarkers: ["_"] };
      const atBoundary = score("ci_deploy_prod", "deploy", markers);
      const midWord = score("cideployprod", "deploy", markers);
      expect(atBoundary).not.toBeNull();
      expect(midWord).not.toBeNull();
      expect(atBoundary!).toBeLessThan(midWord!);
    });
  });

  describe("subsequence scores", () => {
    it("favours letters that sit close together", () => {
      const tight = scoreSubsequenceMatch("cdeployp", "cdp");
      const loose = scoreSubsequenceMatch("ci-deploy-prod", "cdp");
      expect(tight).not.toBeNull();
      expect(loose).not.toBeNull();
      expect(tight!).toBeLessThan(loose!);
    });
  });

  describe("ranked insertion", () => {
    const hit = (item: string, rank: number) => ({ item, score: rank, tieBreaker: item });

    it("keeps the list ordered and capped at the limit", () => {
      const list = [hit("two", 2), hit("four", 4)];
      for (const next of [hit("three", 3), hit("one", 1)]) {
        ranking.insertRanked(list, next, 2);
      }
      expect(list.map(({ item }) => item).join(",")).toBe("one,two");
    });
  });
});
