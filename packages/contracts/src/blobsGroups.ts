import * as Schema from "effect/Schema";

/**
 * Blobs Phase 3 + 8 wire shapes (docs/bots/GROUPS.md, docs/bots/OUTSIDE.md): group chats, team files and outside access.
 * Twins of runtime/src/blobs/{groups,teamfile,outside}/ (the runtime never imports this file). Same wire rules as blobs.ts:
 * every result field is required and nullable (never undefined), timestamps are epoch-ms numbers, input patches use
 * `optionalKey`.
 */
export const GROUP_METHODS = {
  subscribe: "blobs.groups.subscribe",
  create: "blobs.groups.create",
  update: "blobs.groups.update",
  archive: "blobs.groups.archive",
  delete: "blobs.groups.delete",
  teamOptions: "blobs.team.options",
  teamPreview: "blobs.team.preview",
  teamExport: "blobs.team.export",
  teamImportPlan: "blobs.team.importPlan",
  teamImportApply: "blobs.team.importApply",
} as const;

export const OUTSIDE_METHODS = {
  setup: "blobs.outside.setup",
  tokens: "blobs.outside.tokens",
  create: "blobs.outside.create",
  revoke: "blobs.outside.revoke",
  audit: "blobs.outside.audit",
} as const;

// ── groups ───────────────────────────────────────────────────────────────────────────────────────────────────
export const GroupRule = Schema.Literals(["mention", "lead", "auto"]);
export type GroupRule = Schema.Schema.Type<typeof GroupRule>;

export const GroupWire = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  memberIds: Schema.Array(Schema.String),
  leadId: Schema.String,
  rule: GroupRule,
  instructions: Schema.String,
  /** Absolute path of the shared folder. */
  workspace: Schema.String,
  pinned: Schema.Boolean,
  archivedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type GroupWire = Schema.Schema.Type<typeof GroupWire>;

/** `blobs.groups.subscribe`: the whole group list, re-sent on every change (seeded on subscribe). */
export const GroupsStreamEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  seq: Schema.Number,
  groups: Schema.Array(GroupWire),
});
export type GroupsStreamEvent = Schema.Schema.Type<typeof GroupsStreamEvent>;
export const GroupsSubscribeInput = Schema.Struct({});
export type GroupsSubscribeInput = Schema.Schema.Type<typeof GroupsSubscribeInput>;

export const GroupCreateInput = Schema.Struct({
  name: Schema.String,
  memberIds: Schema.Array(Schema.String),
  leadId: Schema.optionalKey(Schema.String),
  rule: Schema.optionalKey(GroupRule),
  instructions: Schema.optionalKey(Schema.String),
});
export type GroupCreateInput = Schema.Schema.Type<typeof GroupCreateInput>;

export const GroupUpdateInput = Schema.Struct({
  id: Schema.String,
  patch: Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    memberIds: Schema.optionalKey(Schema.Array(Schema.String)),
    leadId: Schema.optionalKey(Schema.String),
    rule: Schema.optionalKey(GroupRule),
    instructions: Schema.optionalKey(Schema.String),
    pinned: Schema.optionalKey(Schema.Boolean),
  }),
});
export type GroupUpdateInput = Schema.Schema.Type<typeof GroupUpdateInput>;

export const GroupIdInput = Schema.Struct({ id: Schema.String });
export type GroupIdInput = Schema.Schema.Type<typeof GroupIdInput>;
export const GroupDeleteInput = Schema.Struct({ id: Schema.String, confirmName: Schema.String });
export type GroupDeleteInput = Schema.Schema.Type<typeof GroupDeleteInput>;

// ── team files ───────────────────────────────────────────────────────────────────────────────────────────────
export const TeamExportSelection = Schema.Struct({
  blobIds: Schema.Array(Schema.String),
  groupIds: Schema.Array(Schema.String),
  chief: Schema.Boolean,
  routines: Schema.Boolean,
  skills: Schema.Boolean,
  name: Schema.String,
});
export type TeamExportSelection = Schema.Schema.Type<typeof TeamExportSelection>;

export const TeamOptionsInput = Schema.Struct({});
export type TeamOptionsInput = Schema.Schema.Type<typeof TeamOptionsInput>;
const idAndName = { name: Schema.String, id: Schema.String };

export const TeamOptionsResult = Schema.Struct({
  koraId: Schema.NullOr(Schema.String),
  blobs: Schema.Array(
    Schema.Struct({
      ...idAndName,
      title: Schema.String,
      skills: Schema.Number,
      routines: Schema.Number,
    }),
  ),
  groups: Schema.Array(Schema.Struct({ ...idAndName, memberIds: Schema.Array(Schema.String) })),
});
export type TeamOptionsResult = Schema.Schema.Type<typeof TeamOptionsResult>;

export const TeamExportReport = Schema.Struct({
  blobs: Schema.Array(
    Schema.Struct({
      ...idAndName,
      title: Schema.String,
      soulChars: Schema.Number,
      skills: Schema.Number,
      routines: Schema.Number,
      removed: Schema.Number,
    }),
  ),
  groups: Schema.Array(
    Schema.Struct({
      ...idAndName,
      members: Schema.Array(Schema.String),
      lead: Schema.String,
      rule: GroupRule,
      dropped: Schema.NullOr(Schema.String),
    }),
  ),
  chief: Schema.Boolean,
  findings: Schema.Array(Schema.Struct({ kind: Schema.String, count: Schema.Number })),
  scrubNote: Schema.NullOr(Schema.String),
  neverIncluded: Schema.Array(Schema.String),
  bytes: Schema.Number,
});
export type TeamExportReport = Schema.Schema.Type<typeof TeamExportReport>;

export const TeamPreviewInput = Schema.Struct({ selection: TeamExportSelection });
export type TeamPreviewInput = Schema.Schema.Type<typeof TeamPreviewInput>;

export const TeamExportInput = Schema.Struct({ selection: TeamExportSelection });
export type TeamExportInput = Schema.Schema.Type<typeof TeamExportInput>;
export const TeamExportResult = Schema.Struct({
  markdown: Schema.String,
  fileName: Schema.String,
  report: TeamExportReport,
});
export type TeamExportResult = Schema.Schema.Type<typeof TeamExportResult>;

export const TeamImportPlanInput = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
});
export type TeamImportPlanInput = Schema.Schema.Type<typeof TeamImportPlanInput>;

export const TeamImportFlag = Schema.Struct({ kind: Schema.String, text: Schema.String });
export const TeamImportPlan = Schema.Struct({
  planId: Schema.String,
  title: Schema.String,
  description: Schema.String,
  blobs: Schema.Array(
    Schema.Struct({
      fileName: Schema.String,
      name: Schema.String,
      renamed: Schema.Boolean,
      title: Schema.String,
      soul: Schema.String,
      outfit: Schema.NullOr(
        Schema.Struct({
          head: Schema.NullOr(Schema.String),
          face: Schema.NullOr(Schema.String),
          neck: Schema.NullOr(Schema.String),
        }),
      ),
      skills: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
      routines: Schema.Array(
        Schema.Struct({ title: Schema.String, cadence: Schema.String, prompt: Schema.String }),
      ),
      flags: Schema.Array(TeamImportFlag),
      /** You already have a blob with this name; `identical` = same title and personality (nothing to import). */
      existing: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ id: Schema.String, identical: Schema.Boolean })),
      ),
    }),
  ),
  groups: Schema.Array(
    Schema.Struct({
      fileName: Schema.String,
      name: Schema.String,
      renamed: Schema.Boolean,
      members: Schema.Array(Schema.String),
      lead: Schema.String,
      rule: GroupRule,
      instructions: Schema.String,
    }),
  ),
  skipped: Schema.Array(Schema.Struct({ what: Schema.String, why: Schema.String })),
  notes: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  removedSecrets: Schema.Number,
});
export type TeamImportPlan = Schema.Schema.Type<typeof TeamImportPlan>;

export const TeamImportApplyInput = Schema.Struct({
  planId: Schema.String,
  skip: Schema.Struct({
    blobs: Schema.Array(Schema.String),
    groups: Schema.Array(Schema.String),
    /** Planned names whose existing blob takes the file's title, personality and look instead of a renamed copy being made. */
    replace: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
});
export type TeamImportApplyInput = Schema.Schema.Type<typeof TeamImportApplyInput>;
export const TeamImportResult = Schema.Struct({
  blobs: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  groups: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  errors: Schema.Array(Schema.Struct({ what: Schema.String, error: Schema.String })),
});
export type TeamImportResult = Schema.Schema.Type<typeof TeamImportResult>;

// ── outside access ───────────────────────────────────────────────────────────────────────────────────────────
export const OutsideTokenWire = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.Number,
  lastUsedAt: Schema.NullOr(Schema.Number),
  revokedAt: Schema.NullOr(Schema.Number),
  /** Last four characters of the token, to tell two apart. The token itself is never stored. */
  suffix: Schema.String,
});
export type OutsideTokenWire = Schema.Schema.Type<typeof OutsideTokenWire>;

export const OutsideAuditWire = Schema.Struct({
  id: Schema.String,
  at: Schema.Number,
  tokenId: Schema.String,
  client: Schema.String,
  tool: Schema.String,
  target: Schema.NullOr(Schema.String),
  ok: Schema.Boolean,
  note: Schema.NullOr(Schema.String),
});
export type OutsideAuditWire = Schema.Schema.Type<typeof OutsideAuditWire>;

export const OutsideSetupInput = Schema.Struct({});
export type OutsideSetupInput = Schema.Schema.Type<typeof OutsideSetupInput>;
export const OutsideSetupResult = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  serverName: Schema.String,
  limits: Schema.Struct({ callsPerMinute: Schema.Number, sendsPerMinute: Schema.Number }),
});
export type OutsideSetupResult = Schema.Schema.Type<typeof OutsideSetupResult>;

export const OutsideTokensResult = Schema.Struct({ tokens: Schema.Array(OutsideTokenWire) });
export type OutsideTokensResult = Schema.Schema.Type<typeof OutsideTokensResult>;

export const OutsideCreateInput = Schema.Struct({ name: Schema.String });
export type OutsideCreateInput = Schema.Schema.Type<typeof OutsideCreateInput>;
export const OutsideCreateResult = Schema.Struct({
  token: OutsideTokenWire,
  secret: Schema.String,
});
export type OutsideCreateResult = Schema.Schema.Type<typeof OutsideCreateResult>;

export const OutsideRevokeInput = Schema.Struct({ id: Schema.String });
export type OutsideRevokeInput = Schema.Schema.Type<typeof OutsideRevokeInput>;
export const OutsideRevokeResult = Schema.Struct({ revoked: Schema.Boolean });
export type OutsideRevokeResult = Schema.Schema.Type<typeof OutsideRevokeResult>;

export const OutsideAuditInput = Schema.Struct({ before: Schema.NullOr(Schema.Number) });
export type OutsideAuditInput = Schema.Schema.Type<typeof OutsideAuditInput>;
export const OutsideAuditResult = Schema.Struct({
  rows: Schema.Array(OutsideAuditWire),
  next: Schema.NullOr(Schema.Number),
});
export type OutsideAuditResult = Schema.Schema.Type<typeof OutsideAuditResult>;
