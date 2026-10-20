import type { PromptCommandItem } from "./PromptCommandMenu";
import { scoreAgentSkill } from "../../agentSkillSearch";
import { scoreQueryMatch, normalizeSearchQuery, insertRanked } from "@kora/shared/fuzzyRank";

type SlashSearchItem = Extract<
  PromptCommandItem,
  { type: "provider-slash-command" | "slash-command" | "skill" }
>;

/**
 * A provider expands a slash command only when it opens the whole message;
 * anywhere else it reaches the agent as literal text, so it is not offered
 * there. Built-ins apply locally on selection and skills insert a `$` mention
 * the server dispatches from any position, so both stay available.
 */
export function slashCommandItemsForPromptPosition(
  items: ReadonlyArray<SlashSearchItem>,
  atPromptStart: boolean,
): SlashSearchItem[] {
  return atPromptStart
    ? Array.from(items)
    : items.filter((item) => item.type !== "provider-slash-command");
}

function scoreSkillItem(item: Extract<SlashSearchItem, { type: "skill" }>, query: string) {
  if (query === "skill") {
    return 0;
  }
  const skillQuery = query.startsWith("skill:") ? query.slice("skill:".length) : query;
  const skillScore = skillQuery === "" ? 0 : scoreAgentSkill(item.skill, skillQuery);
  if (skillScore === null) {
    return "skill".startsWith(query) ? Number.MAX_SAFE_INTEGER : null;
  }
  return skillScore;
}

function scoreSlashCommandItem(item: SlashSearchItem, query: string): number | null {
  if (item.type === "skill") {
    return scoreSkillItem(item, query);
  }

  const commandName = item.type === "slash-command" ? item.command : item.command.name;
  const commandScore = scoreQueryMatch({
    boundaryMarkers: ["-", "_", "/"],
    value: commandName.toLowerCase(),
    includesBase: 6,
    boundaryBase: 4,
    fuzzyBase: 100,
    prefixBase: 2,
    exactBase: 0,
    query,
  });
  const descriptionScore = scoreQueryMatch({
    value: item.description.toLowerCase(),
    includesBase: 26,
    boundaryBase: 24,
    prefixBase: 22,
    exactBase: 20,
    query,
  });

  if (commandScore === null) return descriptionScore;
  return descriptionScore === null ? commandScore : Math.min(commandScore, descriptionScore);
}

function tieBreakerFor(item: SlashSearchItem): string {
  switch (item.type) {
    case "slash-command":
      return `0\u0000${item.command}`;
    case "provider-slash-command":
      return `1\u0000${item.command.name}\u0000${item.provider}`;
    default:
      return `2\u0000${item.skill.name}\u0000${item.provider}`;
  }
}

export function searchSlashCommandItems(
  items: ReadonlyArray<SlashSearchItem>,
  typed: string,
): SlashSearchItem[] {
  const normalizedQuery = normalizeSearchQuery(typed, { trimLeadingPattern: /^\/+/ });
  if (!normalizedQuery) {
    return Array.from(items);
  }

  const ranked: Array<{ score: number; tieBreaker: string; item: SlashSearchItem }> = [];
  items.forEach((item) => {
    const score = scoreSlashCommandItem(item, normalizedQuery);
    if (score !== null) {
      insertRanked(
        ranked,
        { item, score, tieBreaker: tieBreakerFor(item) },
        Number.POSITIVE_INFINITY,
      );
    }
  });

  return ranked.map((entry) => entry.item);
}
