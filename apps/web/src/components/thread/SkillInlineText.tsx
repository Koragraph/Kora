import { formatAgentSkillDisplayName } from "@kora/client-runtime/agentSkills";
import type { AgentSkill } from "@kora/contracts";
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

import { mark, pill, SKILL_GLYPH_SVG } from "../tagStyles";
import { cn } from "~/util/utils";

type SkillRef = Pick<AgentSkill, "name" | "displayName">;

// "$name": at the start or after whitespace, starts alphanumeric, has a letter, ends at whitespace/end.
const SKILL_TOKEN = /(^|\s)\$([A-Za-z0-9][A-Za-z0-9:_-]*)(?=\s|$)/g;
// "$5", "$10k", "$2e6": amounts, not skills.
const MONEY_LIKE = /^(?:[0-9_]+(?:[kmbt]|e[0-9]+)?)$/i;

function isSkillName(name: string): boolean {
  return /[A-Za-z]/.test(name) && !MONEY_LIKE.test(name);
}

function Chip({ skill, token }: { skill: SkillRef; token: string }) {
  return (
    <span className="inline-flex align-middle leading-none" data-markdown-copy={token}>
      <span className={cn(mark.base, mark.tint)}>
        <span
          aria-hidden="true"
          className={pill.icon}
          dangerouslySetInnerHTML={{ __html: SKILL_GLYPH_SVG }}
        />
        <span className={mark.label}>{formatAgentSkillDisplayName(skill)}</span>
      </span>
    </span>
  );
}

export function SkillInlineText({
  text,
  skills,
}: {
  text: string;
  skills: ReadonlyArray<SkillRef>;
}) {
  const byName = new Map(skills.map((skill) => [skill.name, skill] as const));
  const parts: ReactNode[] = [];
  let cursor = 0;
  let replaced = false;

  for (const match of text.matchAll(SKILL_TOKEN)) {
    const lead = match[1] ?? "";
    const name = match[2] ?? "";
    const skill = isSkillName(name) ? byName.get(name) : undefined;
    if (!skill) continue;
    const dollarAt = (match.index ?? 0) + lead.length;
    parts.push(text.slice(cursor, dollarAt));
    parts.push(<Chip key={`${dollarAt}:${name}`} skill={skill} token={`$${name}`} />);
    cursor = dollarAt + 1 + name.length;
    replaced = true;
  }

  if (!replaced) return <>{text}</>;
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function tagOf(element: ReactElement): string | undefined {
  if (typeof element.type === "string") return element.type;
  const node = (element.props as { node?: { tagName?: unknown } }).node;
  return typeof node?.tagName === "string" ? node.tagName : undefined;
}

export function renderSkillInlineMarkdownChildren(
  children: ReactNode,
  skills: ReadonlyArray<SkillRef>,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return <SkillInlineText skills={skills} text={child} />;
    if (!isValidElement(child)) return child;
    const tag = tagOf(child);
    if (tag === "code" || tag === "a") return child;
    const inner = (child.props as { children?: ReactNode }).children;
    if (inner === undefined) return child;
    return cloneElement(
      child as ReactElement<{ children?: ReactNode }>,
      undefined,
      renderSkillInlineMarkdownChildren(inner, skills),
    );
  });
}
