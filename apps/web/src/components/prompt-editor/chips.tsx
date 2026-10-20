import type { AgentSkill } from "@kora/contracts";
import { formatAgentSkillDisplayName } from "@kora/client-runtime/agentSkills";
import { serializePromptFileLink } from "@kora/shared/promptTrigger";
import { $applyNodeReplacement } from "lexical";
import type { NodeKey, SerializedLexicalNode, Spread } from "lexical";
import { createContext, use, type ReactElement } from "react";

import { basenameOfPath } from "~/appearance/pierre-icons";
import { ContextChipActionsContext } from "../contextChipPresentation";
import { ContextTagPopover } from "../contextTagParts";
import { pill, skillPill, SKILL_GLYPH_SVG } from "../tagStyles";
import { FILE_TAG_CHIP_CLASS_NAME, FileTagBody } from "../thread/FileTagChip";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InlineChipNode } from "./inlineChip";

// ---- file chips: `@path` / `[name](path)` ------------------------------------------------------------------------

type FileChipJSON = Spread<
  { type: "prompt-file"; version: 1; path: string; source?: string },
  SerializedLexicalNode
>;

function FileChip({ path }: { path: string }) {
  const { openMention } = use(ContextChipActionsContext);
  const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-prompt-mention-chip="true"
            contentEditable={false}
            spellCheck={false}
            aria-label={`Preview ${path}`}
            className={`${FILE_TAG_CHIP_CLASS_NAME} cursor-pointer focus-visible:outline-2`}
            onClick={() => openMention(path)}
          >
            <FileTagBody path={path} label={basenameOfPath(path)} theme={theme} />
          </button>
        }
      />
      <TooltipPopup side="top" className="max-w-120 whitespace-normal leading-tight wrap-anywhere">
        {path}
      </TooltipPopup>
    </Tooltip>
  );
}

/** A file the prompt points at. `source` is the exact text it was written as, kept so the prompt reads back the same. */
export class FileChipNode extends InlineChipNode {
  __path: string;
  __source: string;

  static override getType(): string {
    return "prompt-file";
  }

  static override clone(from: FileChipNode): FileChipNode {
    return new FileChipNode(from.__path, from.__source, from.__key);
  }

  static override importJSON(json: FileChipJSON): FileChipNode {
    // Older JSON may lack `source`; the canonical link is written for it.
    return $createFileChipNode(json.path, json.source).updateFromJSON(json);
  }

  constructor(path: string, source?: string, key?: NodeKey) {
    super(key);
    this.__path = path;
    this.__source = source ?? serializePromptFileLink(path);
  }

  override exportJSON(): FileChipJSON {
    return {
      ...super.exportJSON(),
      type: "prompt-file",
      version: 1,
      path: this.__path,
      source: this.__source,
    };
  }

  override getTextContent(): string {
    return this.__source;
  }

  override decorate(): ReactElement {
    return <FileChip path={this.__path} />;
  }
}

export function $createFileChipNode(path: string, source?: string): FileChipNode {
  return $applyNodeReplacement(new FileChipNode(path, source));
}

// ---- skill chips: `$name` -----------------------------------------------------------------------------------------

/** How a skill chip presents itself: its display name, and a one-line description when there is one. */
export type SkillChipDetails = { label: string; description: string | null };

interface SerializedSkillRecord {
  readonly type: "prompt-skill";
  readonly version: 1;
  readonly skillName: string;
  readonly skillLabel?: string;
  readonly skillDescription?: string;
}

type SkillChipJSON = Spread<SerializedSkillRecord, SerializedLexicalNode>;

/** The skills the composer knows of, so a chip can show the full description and a link to the skill's file. */
export const PromptSkillsContext = createContext<ReadonlyArray<AgentSkill>>([]);

/** Display details for each skill by name. */
export function skillChipDetails(
  skills: ReadonlyArray<AgentSkill>,
): ReadonlyMap<string, SkillChipDetails> {
  const details = new Map<string, SkillChipDetails>();
  for (const skill of skills) {
    const description = skill.shortDescription?.trim() || skill.description?.trim() || null;
    details.set(skill.name, { label: formatAgentSkillDisplayName(skill), description });
  }
  return details;
}

function SkillChip(props: { name: string } & SkillChipDetails) {
  const { openMention } = use(ContextChipActionsContext);
  const skill = use(PromptSkillsContext).find((s) => s.name === props.name);
  const description =
    skill?.description ?? props.description ?? "No description is available for this skill.";
  return (
    <ContextTagPopover
      accessibleLabel={`Skill ${props.label}`}
      triggerClassName={skillPill}
      chip={
        <>
          <span
            aria-hidden="true"
            className={pill.icon}
            dangerouslySetInnerHTML={{ __html: SKILL_GLYPH_SVG }}
          />
          <span className={pill.label}>{props.label}</span>
        </>
      }
    >
      <div className="space-y-3 p-2 text-sm">
        <p className="font-medium">{props.label}</p>
        <p>{description}</p>
        {skill?.path ? (
          <Button variant="outline" size="sm" onClick={() => openMention(skill.path)}>
            View instructions
          </Button>
        ) : null}
      </div>
    </ContextTagPopover>
  );
}

/** A skill the prompt invokes. Its text is `$name`. */
export class SkillChipNode extends InlineChipNode {
  __name: string;
  __details: SkillChipDetails;

  static override getType(): string {
    return "prompt-skill";
  }

  static override clone(from: SkillChipNode): SkillChipNode {
    return new SkillChipNode(from.__name, from.__details, from.__key);
  }

  static override importJSON(json: SkillChipJSON): SkillChipNode {
    const details = {
      label: json.skillLabel ?? json.skillName,
      description: json.skillDescription ?? null,
    };
    return $createSkillChipNode(json.skillName, details).updateFromJSON(json);
  }

  constructor(name: string, details: SkillChipDetails, key?: NodeKey) {
    super(key);
    this.__name = name.replace(/^\$/, "");
    this.__details = details;
  }

  override exportJSON(): SkillChipJSON {
    const { label, description } = this.__details;
    return {
      ...super.exportJSON(),
      type: "prompt-skill",
      version: 1,
      skillName: this.__name,
      skillLabel: label,
      ...(description ? { skillDescription: description } : {}),
    };
  }

  override getTextContent(): string {
    return `$${this.__name}`;
  }

  override decorate(): ReactElement {
    return <SkillChip name={this.__name} {...this.__details} />;
  }
}

export function $createSkillChipNode(name: string, details: SkillChipDetails): SkillChipNode {
  return $applyNodeReplacement(new SkillChipNode(name, details));
}
