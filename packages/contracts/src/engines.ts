// Settings > Engines (Phase 7): the engines beyond the native Claude / Codex / OpenCode drivers - ACP agents, API endpoints,
// named Claude accounts - and the explicit executable paths. Two RPCs: `engines.list` (the whole page, one snapshot) and
// `engines.do` (one tagged action; it answers with the fresh snapshot plus the action's own result). Keys are write-only on
// the wire: a result never carries one, only `hasKey`. See packages/runtime/src/server/engines.ts.
import * as Schema from "effect/Schema";

export const ENGINE_METHODS = {
  list: "engines.list",
  do: "engines.do",
} as const;

export const EngineFamily = Schema.Literals([
  "claude",
  "codex",
  "opencode",
  "antigravity",
  "acp",
  "api",
]);

export const EngineRow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  family: EngineFamily,
  available: Schema.Boolean,
  /** Why not, in a sentence. Present whenever `available` is false. */
  reason: Schema.optionalKey(Schema.String),
  executable: Schema.optionalKey(Schema.String),
  explicitPath: Schema.optionalKey(Schema.Boolean),
  needsKey: Schema.optionalKey(Schema.Boolean),
  /** An ACP agent that failed to start and is parked until the user re-checks it. */
  parked: Schema.optionalKey(Schema.Boolean),
});
export type EngineRow = typeof EngineRow.Type;

export const EngineAcpView = Schema.Struct({
  agentId: Schema.String,
  label: Schema.String,
  command: Schema.String,
  executable: Schema.NullOr(Schema.String),
  args: Schema.Array(Schema.String),
  defaultArgs: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  custom: Schema.Boolean,
  status: EngineRow,
});
export type EngineAcpView = typeof EngineAcpView.Type;

export const EngineApiProtocol = Schema.Literals(["openai", "anthropic"]);
export const EngineApiView = Schema.Struct({
  id: Schema.String,
  agentId: Schema.String,
  label: Schema.String,
  protocol: EngineApiProtocol,
  baseUrl: Schema.String,
  requiresKey: Schema.Boolean,
  defaultModel: Schema.optionalKey(Schema.String),
  hasKey: Schema.Boolean,
  status: EngineRow,
});
export type EngineApiView = typeof EngineApiView.Type;

export const EngineAccountView = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  configDir: Schema.String,
  createdAt: Schema.Number,
  signIn: Schema.Literals(["signed-in", "signed-out", "unknown"]),
  email: Schema.optionalKey(Schema.String),
  signInCommand: Schema.String,
});
export type EngineAccountView = typeof EngineAccountView.Type;

export const EnginePreset = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  protocol: EngineApiProtocol,
  baseUrl: Schema.String,
  requiresKey: Schema.Boolean,
  defaultModel: Schema.optionalKey(Schema.String),
});

export const EnginesView = Schema.Struct({
  engines: Schema.Array(EngineRow),
  acp: Schema.Array(EngineAcpView),
  endpoints: Schema.Array(EngineApiView),
  accounts: Schema.Array(EngineAccountView),
  presets: Schema.Array(EnginePreset),
  acpIdleMinutes: Schema.Number,
});
export type EnginesView = typeof EnginesView.Type;

export const EnginesListInput = Schema.Struct({});
export type EnginesListInput = typeof EnginesListInput.Type;

export const EngineModel = Schema.Struct({ id: Schema.String, name: Schema.String });

const op = <K extends string, F extends Schema.Struct.Fields>(name: K, fields: F) =>
  Schema.Struct({ op: Schema.Literal(name), ...fields });

/** One action. `key` fields travel once, in the request, and are never echoed. */
export const EnginesDoInput = Schema.Union([
  op("acp.save", {
    agentId: Schema.String,
    label: Schema.optionalKey(Schema.String),
    command: Schema.optionalKey(Schema.String),
    executable: Schema.optionalKey(Schema.NullOr(Schema.String)),
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
  op("acp.remove", { agentId: Schema.String }),
  op("acp.models", { agentId: Schema.String }),
  op("acp.idle", { minutes: Schema.Number }),
  op("exe.set", {
    engine: Schema.Literals(["claude", "codex", "opencode", "antigravity"]),
    path: Schema.NullOr(Schema.String),
  }),
  op("api.save", {
    id: Schema.String,
    label: Schema.optionalKey(Schema.String),
    protocol: Schema.optionalKey(EngineApiProtocol),
    baseUrl: Schema.optionalKey(Schema.String),
    requiresKey: Schema.optionalKey(Schema.Boolean),
    defaultModel: Schema.optionalKey(Schema.String),
  }),
  op("api.remove", { id: Schema.String }),
  op("api.setKey", { id: Schema.String, key: Schema.String }),
  op("api.clearKey", { id: Schema.String }),
  /** `key` set = test that typed key without saving it; absent = the saved key. Sends no chat message. */
  op("api.test", { id: Schema.String, key: Schema.optionalKey(Schema.String) }),
  op("api.models", { id: Schema.String }),
  op("account.add", { name: Schema.String, label: Schema.optionalKey(Schema.String) }),
  op("account.rename", { name: Schema.String, label: Schema.String }),
  op("account.remove", { name: Schema.String }),
  op("account.check", { name: Schema.String }),
  op("refresh", {}),
]);
export type EnginesDoInput = typeof EnginesDoInput.Type;

export const EnginesDoResult = Schema.Struct({
  view: EnginesView,
  /** acp.models / api.models */
  models: Schema.optionalKey(Schema.Array(EngineModel)),
  current: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** acp.models: the agent could not list its models. */
  error: Schema.optionalKey(Schema.String),
  /** api.test */
  test: Schema.optionalKey(
    Schema.Struct({
      ok: Schema.Boolean,
      kind: Schema.String,
      message: Schema.String,
      status: Schema.optionalKey(Schema.Number),
      modelCount: Schema.optionalKey(Schema.Number),
    }),
  ),
  /** account.add / account.check */
  account: Schema.optionalKey(EngineAccountView),
});
export type EnginesDoResult = typeof EnginesDoResult.Type;
