import {
  AntigravityIcon,
  ClaudeCodeIcon,
  OpenCodeIcon,
  CursorIcon,
  GeminiIcon,
  CodexIcon,
  GrokIcon,
  Icon,
} from "../BrandIcons";
import { AgentId } from "@kora/contracts";

// Our own Claude Code and Codex brand marks (from the kora UI assets) instead of
// Anthropic's / OpenAI's stock logos — each provider keeps its own distinct icon.
export const AGENT_ICON_BY_AGENT: Partial<Record<AgentId, Icon>> = {
  [AgentId.make("antigravity")]: AntigravityIcon,
  [AgentId.make("gemini")]: GeminiIcon,
  [AgentId.make("grok")]: GrokIcon,
  [AgentId.make("cursor")]: CursorIcon,
  [AgentId.make("opencode")]: OpenCodeIcon,
  // OpenCode over its Agent Client Protocol (runtime engine-detect-ext.ts): the same program, so the same mark.
  [AgentId.make("acp-opencode")]: OpenCodeIcon,
  [AgentId.make("claude")]: ClaudeCodeIcon,
  [AgentId.make("codex")]: CodexIcon,
};

export type ModelEsque = {
  name: string;
  slug: string;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  shortName?: string | undefined;
  isDefault?: boolean | undefined;
  subProvider?: string | undefined;
  isUnavailable?: boolean | undefined;
  aliases?: ReadonlyArray<string> | undefined;
};

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const prefix = qualifier?.trim();
  if (!prefix) return value;

  const escaped = prefix.replace(REGEXP_SPECIALS, "\\$&");
  const leading = new RegExp(`^${escaped}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(leading, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  settings?: { preferShortName?: boolean },
): string {
  const wantsShort = settings?.preferShortName && model.shortName;
  const label = wantsShort ? model.shortName! : model.name;
  return stripLeadingQualifier(label, model.subProvider);
}

export function getTriggerDisplayModelName(entry: ModelEsque): string {
  return getDisplayModelName(entry, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  const label = getTriggerDisplayModelName(model);
  return label;
}
