import {
  AntigravityPrefs,
  ClaudePrefs,
  CodexPrefs,
  CursorPrefs,
  GrokPrefs,
  OpenCodePrefs,
  AgentId,
} from "@kora/contracts";
import type * as Schema from "effect/Schema";
import {
  AntigravityIcon,
  ClaudeCodeIcon,
  CodexIcon,
  CursorIcon,
  GrokIcon,
  type Icon,
  OpenCodeIcon,
} from "../BrandIcons";

type AgentPrefsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

/**
 * Browser-safe provider definition. This is deliberately shaped like the
 * future provider package client export: the core web app gets a schema with
 * field annotations plus provider-level presentation metadata, then renders
 * settings generically.
 */
export interface AgentClientDefinition {
  readonly value: AgentId;
  readonly label: string;
  readonly icon: Icon;
  readonly settingsSchema: AgentPrefsSchema;
  /**
   * Optional short label rendered as a `variant="warning"` badge next to
   * the instance title. Used to flag drivers that still ship under an
   * early-access or preview gate — the flag is a property of the driver
   * kind (not a specific instance), so every instance of that driver —
   * built-in default or custom — advertises the same marker.
   */
  readonly badgeLabel?: string;
}

const AGENT_CLIENT_DEFINITIONS: readonly AgentClientDefinition[] = [
  {
    value: AgentId.make("codex"),
    label: "Codex",
    icon: CodexIcon,
    settingsSchema: CodexPrefs,
  },
  {
    value: AgentId.make("claude"),
    label: "Claude",
    icon: ClaudeCodeIcon,
    settingsSchema: ClaudePrefs,
  },
  {
    value: AgentId.make("cursor"),
    label: "Cursor",
    icon: CursorIcon,
    badgeLabel: "Early Access",
    settingsSchema: CursorPrefs,
  },
  {
    value: AgentId.make("grok"),
    label: "Grok",
    icon: GrokIcon,
    badgeLabel: "Early Access",
    settingsSchema: GrokPrefs,
  },
  {
    value: AgentId.make("opencode"),
    label: "OpenCode",
    icon: OpenCodeIcon,
    settingsSchema: OpenCodePrefs,
  },
  {
    value: AgentId.make("antigravity"),
    label: "Antigravity",
    icon: AntigravityIcon,
    settingsSchema: AntigravityPrefs,
  },
];

const AGENT_CLIENT_DEFINITION_BY_VALUE: Partial<Record<AgentId, AgentClientDefinition>> =
  Object.fromEntries(AGENT_CLIENT_DEFINITIONS.map((definition) => [definition.value, definition]));

export const DRIVER_OPTIONS = AGENT_CLIENT_DEFINITIONS;
export const DRIVER_OPTION_BY_VALUE = AGENT_CLIENT_DEFINITION_BY_VALUE;
export type DriverOption = AgentClientDefinition;

/**
 * Look up the driver metadata for an instance's `driver` field. Accepts
 * Returns `undefined` for fork / unknown drivers so callers can decide how
 * to render them — typically by falling back to a generic card.
 */
export function getDriverOption(driver: AgentId | undefined): DriverOption | undefined {
  if (driver === undefined) return undefined;
  return AGENT_CLIENT_DEFINITION_BY_VALUE[driver];
}
