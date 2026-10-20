import * as Schema from "effect/Schema";

/**
 * Extensions (daemon: `packages/runtime/src/extensions/`): MCP servers and skills the user adds once and every agent
 * gets in its own format. Secret values never cross the wire to the client: an entry kept in the keychain comes back
 * as `{ secret: true, value: null }`. Wire rule: every field present, nullable with `NullOr`.
 */
export const EXTENSIONS_METHODS = {
  list: "extensions.list",
  save: "extensions.save",
  remove: "extensions.remove",
  setEnabled: "extensions.setEnabled",
  test: "extensions.test",
  parse: "extensions.parse",
  discover: "extensions.discover",
  catalog: "extensions.catalog",
  addFromCatalog: "extensions.addFromCatalog",
  project: "extensions.project",
  projectApprove: "extensions.projectApprove",
  skillAdd: "extensions.skillAdd",
  skillRemove: "extensions.skillRemove",
  skillSetEnabled: "extensions.skillSetEnabled",
  setProjectSecret: "extensions.setProjectSecret",
} as const;

export const ExtensionAgentId = Schema.Literals(["claude", "codex", "opencode", "antigravity"]);
export type ExtensionAgentId = typeof ExtensionAgentId.Type;

/** One env var or header. `secret`: the value lives in the keychain (`value` is then null on the way out). */
export const ExtensionKeyValue = Schema.Struct({
  key: Schema.String,
  value: Schema.NullOr(Schema.String),
  secret: Schema.Boolean,
});
export type ExtensionKeyValue = typeof ExtensionKeyValue.Type;

export const ExtensionServer = Schema.Struct({
  name: Schema.String,
  transport: Schema.Literals(["stdio", "http"]),
  command: Schema.NullOr(Schema.String),
  args: Schema.Array(Schema.String),
  env: Schema.Array(ExtensionKeyValue),
  url: Schema.NullOr(Schema.String),
  headers: Schema.Array(ExtensionKeyValue),
  enabled: Schema.Boolean,
  agents: Schema.Array(ExtensionAgentId),
  /** Also started for worker panes. */
  workers: Schema.Boolean,
  /** Only sessions inside these folders; empty = everywhere. */
  folders: Schema.Array(Schema.String),
  source: Schema.NullOr(Schema.String),
});
export type ExtensionServer = typeof ExtensionServer.Type;

export const ExtensionSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
  agents: Schema.Array(ExtensionAgentId),
  /** Agents whose skills folder currently links to it. */
  linkedFor: Schema.Array(ExtensionAgentId),
  source: Schema.NullOr(Schema.String),
});
export type ExtensionSkill = typeof ExtensionSkill.Type;

export const ExtensionAgentInfo = Schema.Struct({
  id: ExtensionAgentId,
  label: Schema.String,
  /** How this agent receives servers, in a sentence ("passed at launch", "kept in ~/.gemini/config/mcp_config.json"). */
  delivery: Schema.String,
});
export type ExtensionAgentInfo = typeof ExtensionAgentInfo.Type;

export const ExtensionsListResult = Schema.Struct({
  servers: Schema.Array(ExtensionServer),
  skills: Schema.Array(ExtensionSkill),
  agents: Schema.Array(ExtensionAgentInfo),
});
export type ExtensionsListResult = typeof ExtensionsListResult.Type;

/** A new secret value for `env:<KEY>` or `header:<Name>`. Entries marked secret without a new value keep the saved one. */
export const ExtensionSecretInput = Schema.Struct({ slot: Schema.String, value: Schema.String });
export type ExtensionSecretInput = typeof ExtensionSecretInput.Type;

export const ExtensionSaveInput = Schema.Struct({
  server: ExtensionServer,
  secrets: Schema.Array(ExtensionSecretInput),
  /** When renaming: the name it had. */
  previousName: Schema.NullOr(Schema.String),
});
export type ExtensionSaveInput = typeof ExtensionSaveInput.Type;

export const ExtensionNameInput = Schema.Struct({ name: Schema.String });
export type ExtensionNameInput = typeof ExtensionNameInput.Type;

export const ExtensionEnabledInput = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
});
export type ExtensionEnabledInput = typeof ExtensionEnabledInput.Type;

export const ExtensionTestInput = Schema.Struct({
  /** A saved server by name, or a draft (unsaved) definition. */
  name: Schema.NullOr(Schema.String),
  draft: Schema.NullOr(ExtensionServer),
  secrets: Schema.Array(ExtensionSecretInput),
});
export type ExtensionTestInput = typeof ExtensionTestInput.Type;

export const ExtensionTestResult = Schema.Struct({
  ok: Schema.Boolean,
  ms: Schema.Finite,
  tools: Schema.Array(Schema.String),
  serverName: Schema.NullOr(Schema.String),
  serverVersion: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  stderr: Schema.NullOr(Schema.String),
});
export type ExtensionTestResult = typeof ExtensionTestResult.Type;

export const ExtensionParseInput = Schema.Struct({
  text: Schema.String,
  name: Schema.NullOr(Schema.String),
});
export type ExtensionParseInput = typeof ExtensionParseInput.Type;

export const ExtensionParseResult = Schema.Struct({
  /** Credential-looking literals come back already marked `secret` (value kept so the user can review it). */
  servers: Schema.Array(ExtensionServer),
  warnings: Schema.Array(Schema.String),
});
export type ExtensionParseResult = typeof ExtensionParseResult.Type;

export const ExtensionDiscovered = Schema.Struct({
  server: ExtensionServer,
  /** The agents whose own config already has it. */
  foundIn: Schema.Array(ExtensionAgentId),
  alreadyAdded: Schema.Boolean,
});
export const ExtensionDiscoverResult = Schema.Struct({ items: Schema.Array(ExtensionDiscovered) });
export type ExtensionDiscoverResult = typeof ExtensionDiscoverResult.Type;

export const ExtensionCatalogParam = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["env", "header", "arg"]),
  secret: Schema.Boolean,
  required: Schema.Boolean,
  placeholder: Schema.NullOr(Schema.String),
  help: Schema.NullOr(Schema.String),
});
export const ExtensionCatalogEntry = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  homepage: Schema.String,
  needs: Schema.NullOr(Schema.Literals(["node", "uv"])),
  transport: Schema.Literals(["stdio", "http"]),
  params: Schema.Array(ExtensionCatalogParam),
  added: Schema.Boolean,
});
export type ExtensionCatalogEntry = typeof ExtensionCatalogEntry.Type;
export const ExtensionCatalogResult = Schema.Struct({
  entries: Schema.Array(ExtensionCatalogEntry),
});
export type ExtensionCatalogResult = typeof ExtensionCatalogResult.Type;

export const ExtensionCatalogAddInput = Schema.Struct({
  id: Schema.String,
  answers: Schema.Record(Schema.String, Schema.String),
  agents: Schema.Array(ExtensionAgentId),
  workers: Schema.Boolean,
});
export type ExtensionCatalogAddInput = typeof ExtensionCatalogAddInput.Type;

export const ExtensionProjectInput = Schema.Struct({ cwd: Schema.String });
export const ExtensionProjectResult = Schema.Struct({
  root: Schema.NullOr(Schema.String),
  servers: Schema.Array(
    Schema.Struct({
      server: ExtensionServer,
      approved: Schema.Boolean,
      /** `{ "secret": "<label>" }` names the repo's file uses; each user fills them in once. */
      secretLabels: Schema.Array(Schema.String),
      missingSecrets: Schema.Array(Schema.String),
    }),
  ),
});
export type ExtensionProjectResult = typeof ExtensionProjectResult.Type;
export const ExtensionProjectApproveInput = Schema.Struct({
  cwd: Schema.String,
  name: Schema.String,
  approved: Schema.Boolean,
});
export type ExtensionProjectApproveInput = typeof ExtensionProjectApproveInput.Type;

export const ExtensionProjectSecretInput = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
});
export type ExtensionProjectSecretInput = typeof ExtensionProjectSecretInput.Type;

export const ExtensionSkillAddInput = Schema.Struct({
  source: Schema.String,
  agents: Schema.Array(ExtensionAgentId),
});
export type ExtensionSkillAddInput = typeof ExtensionSkillAddInput.Type;
export const ExtensionSkillAddResult = Schema.Struct({
  installed: Schema.Array(ExtensionSkill),
  skipped: Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String })),
});
export type ExtensionSkillAddResult = typeof ExtensionSkillAddResult.Type;

export const ExtensionOkResult = Schema.Struct({ ok: Schema.Boolean });

/** Every extensions failure. `message` is safe to show. */
export class ExtensionOperationError extends Schema.TaggedError<ExtensionOperationError>()(
  "ExtensionOperationError",
  { operation: Schema.String, message: Schema.String },
) {}
