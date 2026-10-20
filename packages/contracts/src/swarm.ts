import * as Schema from "effect/Schema";
import { WholeNumber, NonblankString } from "./primitives.ts";

/**
 * The Swarm setup contract: readiness, the OpenCode install, free-provider keys and probes,
 * the privacy consent and the swarm preferences. Swarm WORKERS ride the fleet contract
 * (`FleetWorker.swarm`, `FleetSnapshot.swarm` in fleet.ts); this file is only the setup side.
 *
 * Wire rules (docs/swarm/ref-reconciled.md R2): every status field is required and nullable
 * (`NullOr`, never undefined); timestamps are epoch-ms numbers, never `DateTimeUtc`. The same
 * shapes are mirrored as plain TS interfaces in `packages/runtime/src/protocol/types.ts`
 * (the runtime does not import this package); `contracts/src/fixtures/*.json` plus
 * `swarm.test.ts` and `runtime/src/server/swarm-contract.test.ts` keep the two in step.
 */

export const SWARM_METHODS = {
  subscribe: "swarm.subscribe",
  getStatus: "swarm.getStatus",
  installStart: "swarm.install.start",
  installCancel: "swarm.install.cancel",
  setKey: "swarm.setKey",
  clearKey: "swarm.clearKey",
  testProvider: "swarm.testProvider",
  setConsent: "swarm.setConsent",
  setPreferences: "swarm.setPreferences",
} as const;

/** Bump whenever the privacy notice copy or the provider list changes: consent is asked again. */
export const SWARM_PRIVACY_NOTICE_VERSION = 1;

/** The Claude skill the leader loads on entering Swarm mode (`~/.claude/skills/koraswarm/SKILL.md`). */
export const SWARM_SKILL_NAME = "koraswarm";

const EpochMs = Schema.Number;

/** Remote providers (zen / openrouter / cerebras) plus local model servers (ollama / lmstudio: no key, on-machine). */
export const SwarmProviderId = Schema.Literals([
  "zen",
  "openrouter",
  "cerebras",
  "ollama",
  "lmstudio",
]);
export type SwarmProviderId = Schema.Schema.Type<typeof SwarmProviderId>;

export const SwarmBlockerCode = Schema.Literals([
  "opencode-missing",
  "opencode-too-old",
  "koragent-missing",
  "koragent-too-old",
  "consent-missing",
  "no-provider",
  "all-models-cooling",
]);
export type SwarmBlockerCode = Schema.Schema.Type<typeof SwarmBlockerCode>;

export const SwarmBlocker = Schema.Struct({
  code: SwarmBlockerCode,
  message: Schema.String,
});
export type SwarmBlocker = Schema.Schema.Type<typeof SwarmBlocker>;

/** Where the OpenCode binary was found (checked in this order by `resolveOpencodeBinary`). */
export const SwarmOpencodeSource = Schema.Literals([
  "config",
  "kora",
  "path",
  "opencode-home",
  "homebrew",
  "bun",
  "local",
]);
export type SwarmOpencodeSource = Schema.Schema.Type<typeof SwarmOpencodeSource>;

export const SwarmOpencodeStatus = Schema.Struct({
  installed: Schema.Boolean,
  path: Schema.NullOr(Schema.String),
  source: Schema.NullOr(SwarmOpencodeSource),
  version: Schema.NullOr(Schema.String),
  minVersion: Schema.String,
  versionOk: Schema.Boolean,
  /** False when the binary was found outside the daemon's PATH (Kora then uses the absolute path). */
  onDaemonPath: Schema.Boolean,
});
export type SwarmOpencodeStatus = Schema.Schema.Type<typeof SwarmOpencodeStatus>;

/** Same phases as `AgentInstallState` (agentSetup.ts). */
export const SwarmInstallPhase = Schema.Literals([
  "idle",
  ...(["downloading", "extracting", "verifying"] as const),
  ...(["succeeded", "failed", "cancelled"] as const),
]);
export type SwarmInstallPhase = Schema.Schema.Type<typeof SwarmInstallPhase>;

export const SwarmInstallState = Schema.Struct({
  operationId: Schema.NullOr(Schema.String),
  phase: SwarmInstallPhase,
  downloadedBytes: WholeNumber,
  totalBytes: Schema.NullOr(WholeNumber),
  /** The version being installed. */
  version: Schema.NullOr(Schema.String),
  /** The version `--version` reported after install. */
  installedVersion: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
});
export type SwarmInstallState = Schema.Schema.Type<typeof SwarmInstallState>;

/** Global, versioned privacy consent (PLAN D-b). */
export const SwarmConsentState = Schema.Struct({
  requiredVersion: Schema.Number,
  acceptedVersion: Schema.NullOr(Schema.Number),
  acceptedAt: Schema.NullOr(EpochMs),
});
export type SwarmConsentState = Schema.Schema.Type<typeof SwarmConsentState>;

export const SwarmProviderLimits = Schema.Struct({
  requestsPerMinute: Schema.NullOr(Schema.Number),
  requestsPerDay: Schema.NullOr(Schema.Number),
  remainingToday: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(EpochMs),
  isFreeTier: Schema.NullOr(Schema.Boolean),
});
export type SwarmProviderLimits = Schema.Schema.Type<typeof SwarmProviderLimits>;

export const SwarmTestOutcome = Schema.Literals([
  "ok",
  "invalid-key",
  "rate-limited",
  "unreachable",
  "no-free-models",
  "opencode-missing",
]);
export type SwarmTestOutcome = Schema.Schema.Type<typeof SwarmTestOutcome>;

export const SwarmProviderTestResult = Schema.Struct({
  ok: Schema.Boolean,
  outcome: SwarmTestOutcome,
  message: Schema.NullOr(Schema.String),
  /** opencode `-m` ids of the free models the probe found. */
  freeModels: Schema.Array(Schema.String),
  latencyMs: Schema.NullOr(Schema.Number),
  testedAt: EpochMs,
  limits: Schema.NullOr(SwarmProviderLimits),
});
export type SwarmProviderTestResult = Schema.Schema.Type<typeof SwarmProviderTestResult>;

export const SwarmKeySource = Schema.Literals(["kora", "env", "opencode-auth"]);
export type SwarmKeySource = Schema.Schema.Type<typeof SwarmKeySource>;

export const SwarmProviderStatus = Schema.Struct({
  provider: SwarmProviderId,
  enabled: Schema.Boolean,
  keyRequired: Schema.Boolean,
  hasKey: Schema.Boolean,
  keySource: Schema.NullOr(SwarmKeySource),
  /** A masked hint of a saved key (`sk-or-…a1b2`); the key itself never crosses the wire. */
  keyHint: Schema.NullOr(Schema.String),
  lastTest: Schema.NullOr(SwarmProviderTestResult),
  limits: Schema.NullOr(SwarmProviderLimits),
});
export type SwarmProviderStatus = Schema.Schema.Type<typeof SwarmProviderStatus>;

export const SwarmModelInfo = Schema.Struct({
  /** The opencode `-m` value, e.g. `opencode/big-pickle`, `openrouter/qwen/qwen3-coder:free`. */
  id: Schema.String,
  provider: SwarmProviderId,
  /** Short display label, e.g. `big-pickle`. */
  label: Schema.String,
  /** Picker preference; lower is tried first. */
  rank: Schema.Number,
  /** Concurrent workers this model may run (null = no model-level cap). */
  maxConcurrent: Schema.NullOr(Schema.Number),
});
export type SwarmModelInfo = Schema.Schema.Type<typeof SwarmModelInfo>;

export const SwarmModelCooling = Schema.Struct({
  model: Schema.String,
  provider: SwarmProviderId,
  until: EpochMs,
  reason: Schema.String,
});
export type SwarmModelCooling = Schema.Schema.Type<typeof SwarmModelCooling>;

export const SwarmPreferences = Schema.Struct({
  providerOrder: Schema.Array(SwarmProviderId),
  /** null = automatic (best available free model). */
  defaultModel: Schema.NullOr(Schema.String),
  maxWorkers: Schema.Number,
});
export type SwarmPreferences = Schema.Schema.Type<typeof SwarmPreferences>;

/**
 * Worker supply beyond free models (onboarding ↔ worker-routing seam): the `swarm` config block
 * `supply` / `paid` / `local` in ~/.kora/config.json, mirrored key for key. Optional on the wire: a
 * daemon without paid / local routing omits `SwarmStatus.supplyState`, and the UI then offers only
 * what the daemon has. Paid models use the OpenRouter key the providers step already stores.
 */
export const SwarmSupplyMode = Schema.Literals(["free-first", "paid-first", "local-only"]);
export type SwarmSupplyMode = Schema.Schema.Type<typeof SwarmSupplyMode>;

export const SwarmLocalServerId = Schema.Literals(["ollama", "lmstudio"]);
export type SwarmLocalServerId = Schema.Schema.Type<typeof SwarmLocalServerId>;

export const SwarmLocalServerConfig = Schema.Struct({
  enabled: Schema.Boolean,
  baseUrl: Schema.String,
  /** Models workers may use; [] = whatever the server has loaded. */
  models: Schema.Array(Schema.String),
});
export type SwarmLocalServerConfig = Schema.Schema.Type<typeof SwarmLocalServerConfig>;

export const SwarmSupplyState = Schema.Struct({
  supply: SwarmSupplyMode,
  paid: Schema.Struct({
    enabled: Schema.Boolean,
    /** Spend cap per worker task, USD. */
    maxTaskUsd: Schema.Number,
    /** Paid OpenRouter models workers may use; [] = the daemon's cheap defaults. */
    models: Schema.Array(Schema.String),
  }),
  local: Schema.Struct({
    ollama: SwarmLocalServerConfig,
    lmstudio: SwarmLocalServerConfig,
  }),
});
export type SwarmSupplyState = Schema.Schema.Type<typeof SwarmSupplyState>;

const SwarmLocalServerPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  baseUrl: Schema.optionalKey(Schema.String),
  models: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** A partial `SwarmSupplyState`; send only when `SwarmStatus.supplyState` is present. */
export const SwarmSetSupplyInput = Schema.Struct({
  supply: Schema.optionalKey(SwarmSupplyMode),
  paid: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      maxTaskUsd: Schema.optionalKey(Schema.Number),
      models: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  local: Schema.optionalKey(
    Schema.Struct({
      ollama: Schema.optionalKey(SwarmLocalServerPatch),
      lmstudio: Schema.optionalKey(SwarmLocalServerPatch),
    }),
  ),
});
export type SwarmSetSupplyInput = Schema.Schema.Type<typeof SwarmSetSupplyInput>;

export const SwarmKeyStorage = Schema.Literals(["file"]);
export type SwarmKeyStorage = Schema.Schema.Type<typeof SwarmKeyStorage>;

/** Which program runs swarm workers (runtime `WorkerBackendId`). */
export const WorkerBackendId = Schema.Literals(["opencode", "koragent"]);
export type WorkerBackendId = Schema.Schema.Type<typeof WorkerBackendId>;

export const SwarmWorkerBackendStatus = Schema.Struct({
  id: WorkerBackendId,
  installed: Schema.Boolean,
  path: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
  /** koragent only: `koragent --version` (null = no answer) and the gate it is checked against. */
  version: Schema.optionalKey(Schema.NullOr(Schema.String)),
  minVersion: Schema.optionalKey(Schema.String),
  versionOk: Schema.optionalKey(Schema.Boolean),
  /** koragent only: the sha256 Kora pinned at install (null = not installed by Kora) and whether it still matches. */
  pinned: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pinOk: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
export type SwarmWorkerBackendStatus = Schema.Schema.Type<typeof SwarmWorkerBackendStatus>;

export const SwarmStatus = Schema.Struct({
  ready: Schema.Boolean,
  blockers: Schema.Array(SwarmBlocker),
  opencode: SwarmOpencodeStatus,
  install: SwarmInstallState,
  consent: SwarmConsentState,
  /** In preference order. */
  providers: Schema.Array(SwarmProviderStatus),
  models: Schema.Struct({
    available: Schema.Array(SwarmModelInfo),
    cooling: Schema.Array(SwarmModelCooling),
  }),
  preferences: SwarmPreferences,
  keyStorage: SwarmKeyStorage,
  checkedAt: EpochMs,
  /** Paid / local worker supply (config `swarm.supply|paid|local`); absent on daemons without it. */
  supplyState: Schema.optionalKey(SwarmSupplyState),
  /** Config `swarm.workerBackend` and, for koragent, its resolved binary; absent on daemons without it (= opencode). */
  workerBackend: Schema.optionalKey(SwarmWorkerBackendStatus),
});
export type SwarmStatus = Schema.Schema.Type<typeof SwarmStatus>;

/** The `swarm.subscribe` stream: snapshot-only; re-emitted on every change (install progress included). */
export const SwarmStreamEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  status: SwarmStatus,
});
export type SwarmStreamEvent = Schema.Schema.Type<typeof SwarmStreamEvent>;

// ── inputs ───────────────────────────────────────────────────────────────────

export const SwarmSubscribeInput = Schema.Struct({});
export type SwarmSubscribeInput = Schema.Schema.Type<typeof SwarmSubscribeInput>;

export const SwarmGetStatusInput = Schema.Struct({
  /** Re-detect opencode and drop the daemon's caches ("Check again"). */
  probe: Schema.optionalKey(Schema.Boolean),
});
export type SwarmGetStatusInput = Schema.Schema.Type<typeof SwarmGetStatusInput>;

export const SwarmInstallStartInput = Schema.Struct({
  /** The explicit install click; distinct from the privacy consent. */
  confirm: Schema.Literal(true),
  /** Defaults to the pinned version. */
  version: Schema.optionalKey(NonblankString),
});
export type SwarmInstallStartInput = Schema.Schema.Type<typeof SwarmInstallStartInput>;

export const SwarmInstallCancelInput = Schema.Struct({
  operationId: NonblankString,
});
export type SwarmInstallCancelInput = Schema.Schema.Type<typeof SwarmInstallCancelInput>;

export const SwarmSetKeyInput = Schema.Struct({
  provider: SwarmProviderId,
  apiKey: NonblankString.check(Schema.isMaxLength(4_096)),
});
export type SwarmSetKeyInput = Schema.Schema.Type<typeof SwarmSetKeyInput>;

export const SwarmClearKeyInput = Schema.Struct({
  provider: SwarmProviderId,
});
export type SwarmClearKeyInput = Schema.Schema.Type<typeof SwarmClearKeyInput>;

export const SwarmTestProviderInput = Schema.Struct({
  provider: SwarmProviderId,
});
export type SwarmTestProviderInput = Schema.Schema.Type<typeof SwarmTestProviderInput>;

export const SwarmSetConsentInput = Schema.Struct({
  noticeVersion: Schema.Number,
  /** false withdraws consent (Swarm becomes not-ready). */
  accepted: Schema.Boolean,
});
export type SwarmSetConsentInput = Schema.Schema.Type<typeof SwarmSetConsentInput>;

export const SwarmSetPreferencesInput = Schema.Struct({
  providerOrder: Schema.optionalKey(Schema.Array(SwarmProviderId)),
  /** null = automatic. */
  defaultModel: Schema.optionalKey(Schema.NullOr(Schema.String)),
  maxWorkers: Schema.optionalKey(Schema.Number),
  /** Per-provider enabled switches. */
  enabled: Schema.optionalKey(
    Schema.Array(Schema.Struct({ provider: SwarmProviderId, enabled: Schema.Boolean })),
  ),
  /** Paid / local worker supply; send only when `SwarmStatus.supplyState` is present. */
  supplyState: Schema.optionalKey(SwarmSetSupplyInput),
  /** Config `swarm.workerBackend`; send only when `SwarmStatus.workerBackend` is present (daemons that have the seam). */
  workerBackend: Schema.optionalKey(WorkerBackendId),
});
export type SwarmSetPreferencesInput = Schema.Schema.Type<typeof SwarmSetPreferencesInput>;

/** Every swarm setup failure. `message` is safe to show; it never contains a key. */
export class SwarmOperationError extends Schema.TaggedError<SwarmOperationError>()(
  "SwarmOperationError",
  { operation: Schema.String, message: Schema.String },
) {}
