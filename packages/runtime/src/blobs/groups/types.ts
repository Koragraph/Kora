// Group chats (Phase 3, docs/bots/GROUPS.md). Pure shapes: the runtime never imports @kora/contracts, so these are the
// structural twins the ui-server adapts (see WIRING.md).

/** Who answers an un-addressed message. `mention`: nobody unless @mentioned. `lead`: the lead. `auto`: a cheap model picks. */
export type ResponderRule = 'mention' | 'lead' | 'auto';
export const RESPONDER_RULES: readonly ResponderRule[] = ['mention', 'lead', 'auto'];
export const DEFAULT_RESPONDER_RULE: ResponderRule = 'auto';

export const GROUP_NAME_MAX = 40;
export const GROUP_INSTRUCTIONS_MAX = 4_000;
export const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 12;

export interface GroupProfile {
  id: string;
  version: 1;
  name: string;
  /** Folder name under the groups root. */
  slug: string;
  /** Blob ids, in the order the user picked them. Archived / deleted blobs are dropped by `GroupStore.prune`. */
  memberIds: string[];
  /** One of `memberIds`: Kora when she is a member, else the first member. */
  leadId: string;
  rule: ResponderRule;
  /** Shared instructions every member reads on every group turn. */
  instructions: string;
  /** Absolute path of the shared working folder (`~/Blobs/_groups/<slug>`). */
  workspace: string;
  pinned: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface GroupCreateInput {
  name: string;
  memberIds: string[];
  /** Defaults to Kora if she is a member, else the first member. */
  leadId?: string;
  rule?: ResponderRule;
  instructions?: string;
  id?: string;
}

export type GroupPatch = Partial<Pick<GroupProfile, 'name' | 'memberIds' | 'leadId' | 'rule' | 'instructions' | 'pinned'>>;

/** A line of the shared group transcript. `authorId` is a blob id, or `user` for the person, or `system` for notes. */
export interface GroupMessage {
  id: string;
  seq: number;
  authorId: string;
  authorName: string;
  text: string;
  /** Blob ids this message was addressed to ("to Popo, Junip"); empty = nobody in particular. */
  to: string[];
  ts: number;
  kind: 'message' | 'note';
}

/** Where the shared transcript lives. The ui-server backs it with the group thread; tests use `MemoryTranscript`. */
export interface GroupTranscript {
  append(m: Omit<GroupMessage, 'id' | 'seq' | 'ts'> & { ts?: number }): GroupMessage;
  list(): GroupMessage[];
}

/** What the group machinery needs to know about the team. The runtime's BlobStore satisfies it (see `blobDirectoryOf`). */
export interface MemberDirectory {
  has(blobId: string): boolean;
  /** Active (not archived) blob? */
  active(blobId: string): boolean;
  name(blobId: string): string | null;
  isChief(blobId: string): boolean;
}
