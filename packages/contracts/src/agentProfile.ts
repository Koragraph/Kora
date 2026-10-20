/**
 * Provider-instance contracts.
 *
 * Splits the historical "provider kind" concept into two:
 *
 *   - `AgentId` is the implementation kind selector (e.g. codex,
 *     claude, a fork's `ollama`, …). It picks which driver package
 *     handles the protocol, the probe, the adapter, and text generation.
 *
 *   - `AgentProfileId` is the routing key (a user-defined slug).
 *     Threads, sessions, runtime events, and persisted bindings reference
 *     instance ids — never driver kinds — so a user can configure multiple
 *     instances of the same driver (e.g. `codex_personal` + `codex_work`),
 *     each with independent driver-specific configuration.
 *
 * Forward/backward compatibility invariant
 * ----------------------------------------
 * `AgentId` is intentionally an **open** branded slug, not a closed
 * literal union. The server hosts forks, ships in PRs that add drivers, and
 * users frequently roll between branches and forks. Any of those paths can
 * leave `DaemonPrefs`, persisted thread state, or session bindings
 * referencing a driver that the currently-running build does not know about.
 *
 * The rule: parsing any of those payloads must always succeed, and the
 * runtime is responsible for marking the unknown driver/instance as
 * "unavailable" rather than crashing. Built-in drivers shipped by the core
 * product happens to register in a given build is not part of the contract
 * layer. Driver availability is discovered through the runtime registry.
 *
 * Driver-specific configuration is similarly opaque at the contracts layer:
 * drivers live in (or will be extracted to) their own packages and own their
 * config schemas. The contracts package only knows the envelope.
 *
 * @module providerInstance
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonblankString } from "./primitives.ts";

const AGENT_SLUG_MAX_CHARS = 64;
/**
 * Slug pattern shared by driver kinds and instance ids — letters, digits,
 * dashes, underscores. The first character must be a letter so slugs remain
 * JS-identifier friendly when used as object keys, log fields, or telemetry
 * attributes. Mixed case is permitted so historical driver kinds (e.g.
 * `claude`) can be used verbatim during the migration and so external
 * fork authors retain reasonable freedom.
 */
const AGENT_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ENV_VAR_NAME_MAX_CHARS = 128;
const ENV_VAR_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const slugSchema = NonblankString.check(
  Schema.isMaxLength(AGENT_SLUG_MAX_CHARS),
  Schema.isPattern(AGENT_SLUG_PATTERN),
);

/**
 * `AgentId` — open branded slug naming a driver implementation.
 *
 * Constraints (validated at the schema layer):
 *   - starts with a letter
 *   - only letters, digits, `-`, `_` after the first char
 *   - 1..64 characters
 *
 * Notably **not** validated: that the driver is one we know how to load.
 * That check belongs to the runtime registry, which downgrades unknown
 * drivers gracefully (see module docs).
 */
export const AgentId = slugSchema.pipe(Schema.brand("AgentId"));
export type AgentId = typeof AgentId.Type;

const isAgentIdValue = Schema.is(AgentId);
export const isAgentId = (value: unknown): value is AgentId => isAgentIdValue(value);

/**
 * `AgentProfileId` — user-defined routing key for a configured provider
 * instance. Same slug rules as `AgentId`; branded separately so the
 * type system cannot confuse the two.
 */
export const AgentProfileId = slugSchema.pipe(Schema.brand("AgentProfileId"));
export type AgentProfileId = typeof AgentProfileId.Type;

/**
 * Lightweight reference identifying which driver implements an instance.
 * Carried alongside `AgentProfileId` on wire shapes so consumers can
 * branch on driver behavior (icons, capabilities, presentation) without
 * having to look up the instance in the registry.
 */
export const AgentProfileRef = Schema.Struct({
  instanceId: AgentProfileId,
  driver: AgentId,
});
export type AgentProfileRef = typeof AgentProfileRef.Type;

export const AgentProfileEnvVarName = NonblankString.check(
  Schema.isMaxLength(ENV_VAR_NAME_MAX_CHARS),
  Schema.isPattern(ENV_VAR_NAME_PATTERN),
);
export type AgentProfileEnvVarName = typeof AgentProfileEnvVarName.Type;

export const AgentProfileEnvVar = Schema.Struct({
  name: AgentProfileEnvVarName,
  valueRedacted: Schema.optionalKey(Schema.Boolean),
  sensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  value: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type AgentProfileEnvVar = typeof AgentProfileEnvVar.Type;

export const AgentProfileEnv = Schema.Array(AgentProfileEnvVar);
export type AgentProfileEnv = typeof AgentProfileEnv.Type;

/**
 * Envelope shape for a provider instance configuration in `DaemonPrefs`.
 *
 * `driver` is intentionally accepted as any well-formed slug (see module
 * docs). The driver-specific config payload is left as `Schema.Unknown`;
 * each driver registers its own decoder with the runtime registry, and
 * envelopes for unknown drivers are preserved verbatim so they round-trip
 * across version changes without data loss.
 */
export const AgentProfileConfig = Schema.Struct({
  driver: AgentId,
  displayName: Schema.optional(NonblankString),
  accentColor: Schema.optional(NonblankString),
  environment: Schema.optionalKey(AgentProfileEnv),
  enabled: Schema.optionalKey(Schema.Boolean),
  config: Schema.optionalKey(Schema.Unknown),
});
export type AgentProfileConfig = typeof AgentProfileConfig.Type;

/**
 * Map shape for `DaemonPrefs.providerInstances`. Keyed by
 * `AgentProfileId`, values are envelopes the registry feeds to drivers.
 */
export const AgentProfileConfigMap = Schema.Record(AgentProfileId, AgentProfileConfig);
export type AgentProfileConfigMap = typeof AgentProfileConfigMap.Type;

/**
 * Construct the canonical `AgentProfileId` used as a back-compat default
 * for a built-in driver. The legacy single-instance-per-driver world used
 * the driver kind itself as the instance id; preserving that mapping keeps
 * existing persisted threads, bindings, and cache files routable across the
 * migration without rewriting their stored selection payloads.
 */
/**
 * Agent ids that were renamed after they had been persisted (legacy → current): the Claude
 * driver was `claudeAgent` before it took the kora agent id `claude`. Readers of persisted
 * driver/instance ids (model selections, the UI server's thread records) map them through
 * {@link migrateLegacyAgentId} so an old record keeps routing to its agent.
 */
const LEGACY_AGENT_IDS: Readonly<Record<string, string>> = { claudeAgent: "claude" };

/** Map a persisted legacy agent/instance id onto its current id; anything else passes through. */
export const migrateLegacyAgentId = <T>(value: T): T =>
  typeof value === "string" && Object.hasOwn(LEGACY_AGENT_IDS, value)
    ? (LEGACY_AGENT_IDS[value] as T)
    : value;

export const defaultProfileIdForDriver = (driver: AgentId): AgentProfileId =>
  AgentProfileId.make(driver);
