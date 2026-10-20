import { scoreQueryMatch, normalizeSearchQuery, insertRanked } from "@kora/shared/fuzzyRank";
import type { AgentSkill } from "@kora/contracts";
import {
  isAgentSkillUserInvocable,
  formatAgentSkillDisplayName,
  dedupeAgentSkillsByName,
} from "@kora/client-runtime/agentSkills";

type TierBases = {
  exact: number;
  prefix: number;
  boundary?: number;
  includes: number;
  fuzzy?: number;
};

/** One searchable field of a skill and how strongly a hit in it should rank (lower = better). */
type SkillField = {
  text: string;
  bases: TierBases;
  markers?: string[];
};

function skillFields(skill: AgentSkill): SkillField[] {
  const lower = (text: string | undefined | null) => text?.toLowerCase() ?? "";
  return [
    {
      text: lower(skill.name),
      bases: { exact: 0, prefix: 2, boundary: 4, includes: 6, fuzzy: 100 },
      markers: ["-", "_", "/"],
    },
    {
      text: formatAgentSkillDisplayName(skill).toLowerCase(),
      bases: { exact: 1, prefix: 3, boundary: 5, includes: 7, fuzzy: 110 },
    },
    {
      text: lower(skill.shortDescription),
      bases: { exact: 20, prefix: 22, boundary: 24, includes: 26 },
    },
    {
      text: lower(skill.description),
      bases: { exact: 30, prefix: 32, boundary: 34, includes: 36 },
    },
    { text: lower(skill.scope), bases: { exact: 40, prefix: 42, includes: 44 } },
  ];
}

export function scoreAgentSkill(skill: AgentSkill, needle: string): number | null {
  let best: number | null = null;
  for (const { text, bases, markers } of skillFields(skill)) {
    const score = scoreQueryMatch({
      value: text,
      query: needle,
      exactBase: bases.exact,
      prefixBase: bases.prefix,
      ...(bases.boundary === undefined ? {} : { boundaryBase: bases.boundary }),
      includesBase: bases.includes,
      ...(bases.fuzzy === undefined ? {} : { fuzzyBase: bases.fuzzy }),
      ...(markers ? { boundaryMarkers: markers } : {}),
    });
    if (score !== null && (best === null || score < best)) best = score;
  }
  return best;
}

export function searchAgentSkills(
  skills: ReadonlyArray<AgentSkill>,
  needle: string,
  limit = Number.POSITIVE_INFINITY,
): AgentSkill[] {
  const invocable = dedupeAgentSkillsByName(skills.filter(isAgentSkillUserInvocable));
  const query = normalizeSearchQuery(needle, { trimLeadingPattern: /^\$+/ });
  if (!query) return invocable;

  const results: Array<{ tieBreaker: string; score: number; item: AgentSkill }> = [];
  for (const skill of invocable) {
    const score = scoreAgentSkill(skill, query);
    if (score === null) continue;
    const tieBreaker = `${formatAgentSkillDisplayName(skill).toLowerCase()}\u0000${skill.name}`;
    insertRanked(results, { item: skill, score, tieBreaker }, limit);
  }
  return results.map((hit) => hit.item);
}
