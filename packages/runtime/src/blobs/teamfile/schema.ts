// The team file (docs/bots/GROUPS.md "Team files"): ONE portable Markdown file. YAML frontmatter is the data (versioned,
// validated, the only thing import reads); the body is a readable rendering for humans and is never parsed.
//
// What travels: blobs (name, title, SOUL, outfit, starter id, skill names + one-liners, suggested routines), groups
// (members, lead, rule, shared instructions) and Kora's own description. What NEVER travels: chats, memory, keys or
// secrets, model choices, computers, app grants, folders, ids.
import type { ResponderRule } from '../groups/types';
import { RESPONDER_RULES } from '../groups/types';
import { MAX_SOUL_CHARS } from '../store';

export const TEAMFILE_VERSION = 1;
/** Frontmatter key that marks (and versions) a file. */
export const TEAMFILE_MARKER = 'kora_team';
export const TEAMFILE_MAX_BYTES = 256 * 1024;
export const TEAMFILE_MAX_BLOBS = 24;
export const TEAMFILE_MAX_GROUPS = 12;
export const TEAMFILE_MAX_SKILLS = 24;
export const TEAMFILE_MAX_ROUTINES = 12;
export const TEAMFILE_NAME_MAX = 40;
export const TEAMFILE_TITLE_MAX = 60;
export const TEAMFILE_SOUL_MAX = MAX_SOUL_CHARS;
export const TEAMFILE_ROUTINE_PROMPT_MAX = 2_000;
export const TEAMFILE_INSTRUCTIONS_MAX = 4_000;

export interface TeamFileOutfit { head: string | null; face: string | null; neck: string | null }
export interface TeamFileSkill { name: string; description: string }
export interface TeamFileRoutine { title: string; /** Words ("Weekdays at 9:00"), never a live schedule: imported routines are paused. */ cadence: string; prompt: string }

export interface TeamFileBlob {
  name: string;
  title: string;
  soul: string;
  outfit: TeamFileOutfit | null;
  /** A starter id (popo ...) when the blob came from one; informational. */
  template: string | null;
  skills: TeamFileSkill[];
  routines: TeamFileRoutine[];
}

export interface TeamFileGroup {
  name: string;
  /** Blob names as written in this file. "Kora" means the importer's own Kora. */
  members: string[];
  lead: string;
  rule: ResponderRule;
  instructions: string;
}

/** Kora's description. Informational only: an import never changes Kora. */
export interface TeamFileChief { name: string; title: string; soul: string; outfit: TeamFileOutfit | null }

export interface TeamFile {
  version: typeof TEAMFILE_VERSION;
  /** `blob` = a single blob; `team` = several, with groups. */
  kind: 'blob' | 'team';
  name: string;
  description: string;
  exportedAt: string;
  chief: TeamFileChief | null;
  blobs: TeamFileBlob[];
  groups: TeamFileGroup[];
}

export const NEVER_INCLUDED: readonly string[] = ['Chats and memory', 'API keys and secrets', 'Model choices', 'Connected apps and permissions', 'Computers and folders'];

export function isRule(r: unknown): r is ResponderRule { return RESPONDER_RULES.includes(r as ResponderRule); }
