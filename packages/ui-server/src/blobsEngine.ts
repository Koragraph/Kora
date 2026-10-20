// @effect-diagnostics globalDate:off -- plain timestamps at the boundary to the in-process runtime.
// @effect-diagnostics nodeBuiltinImport:off -- the one-time Chief model migration's marker file under KORA_HOME.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Blobs' engine side of the ui-server (docs/bots/ARCH.md sections 3 and 5): which engines a blob can run on right now
 * ("best installed": Claude if signed in, then Codex, then a free OpenCode model), the free OpenCode provider entry the
 * composer's model picker needs, the digest that seeds a "continue on a free model" thread, and the `BlobEngineBridge`
 * the runtime's Chief uses to start and watch blob threads (Phase 2 extends it; Phase 1 only needs it attached).
 */
import { CHIEF_BLOB_ID } from "@kora/contracts";
import type {
  ThreadMessage,
  SwarmStatus,
  BlobEngineAvailability,
  BlobEngine,
} from "@kora/contracts";

import { prettyClaudeId } from "./claudeModels.ts";
import { daemonConfig } from "./config.ts";
import { type BlobEngineBridge, host, type KoraBlobStoreLike } from "./host.ts";
import type { ChatEngine } from "./kora-chat.ts";
import { notifyAgentsChanged } from "./modelRefresh.ts";
import {
  opencodeEffortCapabilities,
  opencodeListedModels,
  opencodeProviderLabel,
} from "./opencodeModels.ts";

const OPENCODE_INSTANCE_ID = "opencode";

type ProviderEntry = (typeof daemonConfig.providers)[number];
const providerOf = (instanceId: string): ProviderEntry | undefined =>
  daemonConfig.providers.find((p) => p.instanceId === instanceId);

/** A provider can lead a blob when it is installed and signed in (Claude stays "ready" with a login problem; this reads auth). */
function providerReady(instanceId: string): boolean {
  const p = providerOf(instanceId);
  return !!p && p.installed !== false && p.status !== "error" && p.auth.status === "authenticated";
}

function defaultModelSlug(instanceId: string, fallback: string): string {
  const models = providerOf(instanceId)?.models ?? [];
  return (models.find((m) => m.isDefault) ?? models[0])?.slug ?? fallback;
}

/**
 * The Claude model a blob gets by default: the newest Sonnet in the catalog (Sonnet 5.5), never the CLI's own default row
 * (that is Opus on most logins, five times the price of a Sonnet turn). Falls back to the `sonnet` alias.
 */
function bestClaudeSlug(): string {
  const models = providerOf("claude")?.models ?? [];
  if (models.some((m) => m.slug === "sonnet")) return "sonnet";
  const sonnets = models
    .filter(
      (m) =>
        /^sonnet\b/i.test(((m as { name?: string }).name ?? m.slug).trim()) ||
        /sonnet/i.test(m.slug),
    )
    .map((m) => ({
      slug: m.slug,
      v: Number(/(\d+(?:\.\d+)?)/.exec((m as { name?: string }).name ?? m.slug)?.[1] ?? 0),
    }))
    .sort((a, b) => b.v - a.v);
  return sonnets[0]?.slug ?? "sonnet";
}

let lastSwarmStatus: SwarmStatus | null = null;
/** The best engine from what is known right now (no awaiting): the runtime's hire/proposal default. */
export function bestEngineNow(): BlobEngine | null {
  return engineAvailabilityFrom(lastSwarmStatus).best;
}

/** The models the app's picker offers for an engine instance (outside access may switch a blob only to one of these). */
export function modelsOfInstance(instanceId: string): Array<{ model: string; label: string }> {
  return (providerOf(instanceId)?.models ?? []).map((m) => ({
    model: m.slug,
    label: (m as { name?: string; shortName?: string }).name ?? m.slug,
  }));
}

/** The free OpenCode models workers could use right now (not cooling), best first. */
function freeModelsOf(status: SwarmStatus | null): string[] {
  if (!status?.ready) return [];
  const cooling = new Set(status.models.cooling.map((c) => c.model));
  return [...status.models.available]
    .filter((m) => !cooling.has(m.id))
    .sort((a, b) => a.rank - b.rank)
    .map((m) => m.id);
}

export async function swarmStatusOrNull(): Promise<SwarmStatus | null> {
  try {
    lastSwarmStatus = (await host().swarm.getStatus()) ?? null;
    return lastSwarmStatus;
  } catch {
    return null;
  }
}

/** The best free OpenCode engine, or null when the swarm is not ready or every model is cooling. */
export async function pickFreeEngine(exclude: readonly string[] = []): Promise<BlobEngine | null> {
  const skip = new Set(exclude);
  const first = freeModelsOf(await swarmStatusOrNull()).find((m) => !skip.has(m));
  return first ? { instanceId: OPENCODE_INSTANCE_ID, model: first, effort: null } : null;
}

/** Which engines exist and which one a new blob gets by default ("best installed"). */
export function engineAvailabilityFrom(status: SwarmStatus | null): BlobEngineAvailability {
  const free = freeModelsOf(status);
  const claude = providerReady("claude");
  const codex = providerReady("codex");
  const best: BlobEngine | null = claude
    ? { instanceId: "claude", model: bestClaudeSlug(), effort: null }
    : codex
      ? { instanceId: "codex", model: defaultModelSlug("codex", "gpt-5-codex"), effort: null }
      : free[0]
        ? { instanceId: OPENCODE_INSTANCE_ID, model: free[0], effort: null }
        : null; // ACP and API engines are never chosen automatically: only when the user picks one
  return {
    best,
    claude: { ready: claude },
    codex: { ready: codex },
    opencode: { ready: free.length > 0, freeModels: free.length },
  };
}

/** The model that learns memory from chats right now: Claude Haiku 5.5 when Claude is signed in, else the best free model, else Claude when the user allowed it. */
function memoryModelName(
  status: SwarmStatus | null,
  claudeFallback: boolean,
  claudeReady: boolean,
): string | null {
  const first = freeModelsOf(status)[0];
  if (first) {
    const label = status?.models.available.find((m) => m.id === first)?.label ?? first;
    return friendlyFreeModelName(label);
  }
  return claudeFallback && claudeReady ? "Claude Haiku 5.5" : null;
}

/** What the extractor chain reports (runtime `OneShotStatus`); only the fields the disclosure needs. */
export interface ExtractorStatusLike {
  readonly lastModel?: string | null;
  readonly retryAt?: number | null;
}

/**
 * The Memory tab's one-line disclosure: the model that REALLY answered last (the chain's own report), "resting until
 * 14:20" when every model is rate limited, else the swarm-status prediction.
 */
export function memoryModelFromStatus(
  extractor: ExtractorStatusLike | null | undefined,
  predicted: string | null,
  now: number,
): string | null {
  const last = extractor?.lastModel ?? null;
  const named = last
    ? /haiku|claude/i.test(last)
      ? `Claude ${prettyClaudeId(last) ?? "Haiku"}`
      : friendlyFreeModelName(last)
    : predicted;
  const retryAt = extractor?.retryAt ?? null;
  if (retryAt !== null && retryAt > now) {
    const at = new Date(retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return named
      ? `${named} (resting until ${at}: the free models are rate limited)`
      : `resting until ${at}: the free models are rate limited`;
  }
  return named;
}

export async function memoryModel(
  claudeFallback: boolean,
  /** A status the caller already read (the snapshot reads it once for both fields); omitted = read it now. */
  status?: SwarmStatus | null,
): Promise<string | null> {
  const predicted = memoryModelName(
    status === undefined ? await swarmStatusOrNull() : status,
    claudeFallback,
    providerReady("claude"),
  );
  let extractor: ExtractorStatusLike | null = null;
  try {
    extractor =
      (host().blobs?.extractorStatus?.() as ExtractorStatusLike | null | undefined) ?? null;
  } catch {
    extractor = null;
  }
  return memoryModelFromStatus(extractor, predicted, Date.now());
}

export async function engineAvailability(
  status?: SwarmStatus | null,
): Promise<BlobEngineAvailability> {
  return engineAvailabilityFrom(status === undefined ? await swarmStatusOrNull() : status);
}

/**
 * `draft.engine ?? defaults.engine ?? best installed` (Claude, Codex, a free OpenCode model). With none of them ready it is
 * Claude's default (editable, like Kora's own) - never an ACP / API engine the user did not pick.
 */
export async function resolveEngine(
  wanted: BlobEngine | null,
  fallback: BlobEngine | null,
): Promise<BlobEngine | null> {
  return (
    wanted ??
    fallback ??
    (await engineAvailability()).best ?? {
      instanceId: "claude",
      model: bestClaudeSlug(),
      effort: null,
    }
  );
}

/** "opencode/big-pickle:free" -> "Big Pickle · free", "deepseek-v4.1-flash-free" -> "Deepseek V4.1 Flash · free": what the picker and the chips show for a free model. */
function friendlyFreeModelName(label: string): string {
  const base = label.replace(/^[^/]+\//, "").replace(/[:-]free$/i, "");
  const words = base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)));
  return `${words.join(" ") || label} · free`;
}

/**
 * Keep the composer's picker in step with the free models: an `opencode` provider entry whose models are the swarm's
 * free list. Added the first time a free model exists; afterwards only its models/readiness change. Pushes to open
 * clients when something changed. (Mutates the decoded config the same way claudeModels.ts / codexModels.ts do.)
 */
export function applyOpencodeFreeModels(status: SwarmStatus | null): boolean {
  lastSwarmStatus = status;
  const free = freeModelsOf(status);
  const labelOf = (id: string): string =>
    status?.models.available.find((m) => m.id === id)?.label ?? id;
  // Everything else the user's OpenCode can run (opencodeModels.ts): free ones after the swarm's, then paid ones by provider.
  const listed = opencodeListedModels();
  const byId = new Map(listed.map((m) => [m.id, m]));
  const freeSet = new Set(free);
  const rest = listed
    .filter((m) => !freeSet.has(m.id))
    .sort((a, b) => Number(b.free) - Number(a.free));
  const models = [
    ...free.map((id) => ({
      slug: id,
      name: friendlyFreeModelName(labelOf(id)),
      variants: byId.get(id)?.variants ?? [],
    })),
    ...rest.map((m) => ({
      slug: m.id,
      name: m.free ? friendlyFreeModelName(m.id) : m.name,
      variants: m.variants,
      ...(m.free ? {} : { subProvider: opencodeProviderLabel(m.provider) }),
    })),
  ].map(({ variants, ...m }, i) => ({
    ...m,
    shortName: m.name,
    isCustom: false,
    ...(i === 0 ? { isDefault: true } : {}),
    capabilities: opencodeEffortCapabilities(variants),
  }));
  const providers = daemonConfig.providers as unknown as ProviderEntry[];
  const existing = providers.find((p) => p.instanceId === OPENCODE_INSTANCE_ID);
  if (!existing) {
    if (models.length === 0) return false;
    providers.push({
      instanceId: OPENCODE_INSTANCE_ID,
      driver: OPENCODE_INSTANCE_ID,
      displayName: "OpenCode",
      supportsTextGeneration: true,
      reportsContextWindow: false,
      status: "ready",
      version: null,
      installed: true,
      enabled: true,
      auth: { status: "authenticated", type: "subscription", label: "free" },
      checkedAt: new Date().toISOString(),
      slashCommands: [],
      skills: [],
      models,
    } as unknown as ProviderEntry);
    const instances = daemonConfig.settings.providerInstances as Record<string, unknown>;
    instances[OPENCODE_INSTANCE_ID] = {
      driver: OPENCODE_INSTANCE_ID,
      enabled: true,
      displayName: "OpenCode",
    };
    notifyAgentsChanged();
    return true;
  }
  const before = JSON.stringify([existing.status, existing.installed, existing.models]);
  const target = existing as unknown as {
    status: string;
    installed: boolean;
    models: unknown[];
  };
  (target as { displayName?: string }).displayName = "OpenCode";
  target.models = models;
  target.installed = models.length > 0;
  target.status = models.length > 0 ? "ready" : "error";
  if (JSON.stringify([target.status, target.installed, target.models]) === before) return false;
  notifyAgentsChanged();
  return true;
}

/** Re-build the OpenCode entry after the user's own model list changed (opencodeModels.ts). */
export function reapplyOpencodeModels(): void {
  applyOpencodeFreeModels(lastSwarmStatus);
}

/**
 * Kora (the Chief) always exists: created the first time the daemon runs with Blobs, on the best installed engine
 * (Claude, then Codex, then a free model; Claude's default when nothing is signed in yet — it is editable). Waits for
 * the readiness probe so the engine reflects what is really installed. Never throws.
 */
export async function ensureChiefBlob(): Promise<void> {
  try {
    const blobs = host().blobs;
    if (!blobs?.ensureKora || blobs.store.get(CHIEF_BLOB_ID)) return;
    const best = (await engineAvailability()).best;
    const engine: BlobEngine = best ?? {
      instanceId: "claude",
      model: bestClaudeSlug(),
      effort: null,
    };
    blobs.ensureKora(engine);
  } catch (cause) {
    host().log(
      `[kora-ui] blobs: could not create Kora (${String((cause as Error)?.message ?? cause)})`,
    );
  }
}

const CHIEF_MODEL_MARKER = "chief-model-migrated.json";

/**
 * One-time fix for Chiefs made before blobs defaulted to Sonnet: their engine says Claude `default`, which the CLI
 * resolves to Opus (about five times a Sonnet turn) for the most-used assistant. Moves that to the same model new blobs
 * get. Marker-guarded, so a user who picks Default for Kora later keeps it. Never throws.
 */
export async function migrateChiefDefaultModel(
  store: Pick<KoraBlobStoreLike, "get" | "update">,
  home: string,
  bestModel: () => string = bestClaudeSlug,
): Promise<boolean> {
  try {
    const marker = NodePath.join(home, CHIEF_MODEL_MARKER);
    if (NodeFS.existsSync(marker)) return false;
    const chief = store.get(CHIEF_BLOB_ID);
    if (!chief) return false;
    let changed = false;
    if (chief.engine.instanceId === "claude" && chief.engine.model === "default") {
      await store.update(CHIEF_BLOB_ID, { engine: { ...chief.engine, model: bestModel() } });
      changed = true;
    }
    NodeFS.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), changed }) + "\n");
    return changed;
  } catch (cause) {
    host().log(
      `[kora-ui] blobs: Chief model migration skipped (${String((cause as Error)?.message ?? cause)})`,
    );
    return false;
  }
}

const SEED_MESSAGES = 6;
const SEED_CHARS = 1500;

const clip = (text: string): string =>
  text.length > SEED_CHARS ? `${text.slice(0, SEED_CHARS)}\n[...cut]` : text;

/**
 * The first message of a "continue on a free model" thread: the last six real messages as a digest, then the user
 * request nobody answered yet (the last message, when it is the user's). Kora-authored notes are not part of it.
 */
export function buildContinueSeed(i: {
  messages: ReadonlyArray<Pick<ThreadMessage, "role" | "text" | "notice">>;
  fromEngine: string;
  toModel: string;
}): string {
  const real = i.messages.filter(
    (m) => (m.role === "user" || m.role === "assistant") && !m.notice && m.text.trim(),
  );
  const recent = real.slice(-SEED_MESSAGES);
  const last = real[real.length - 1];
  const pending = last?.role === "user" ? last : null;
  const lines = [
    `[kora] You are carrying on a conversation that was running on ${i.fromEngine}, which hit its usage limit; you are now on the free model ${i.toModel}. This is a new thread, so you have not seen the earlier messages. The latest ones, oldest first:`,
    "",
    ...recent.map((m) => `${m.role === "user" ? "User" : "You"}: ${clip(m.text.trim())}`),
    "",
    pending
      ? `The user's last message has not been answered yet. Answer it now:\n${clip(pending.text.trim())}`
      : "Your last reply was the end of that exchange. Greet the user in one line, say you are continuing on a free model, and ask how they want to go on.",
  ];
  return lines.join("\n");
}

/** The runtime-facing bridge over the chat engine. Method-for-method `BlobEngineBridge` (host.ts). */
export function makeBlobEngineBridge(engine: ChatEngine): BlobEngineBridge {
  return {
    startThread: (p) => engine.startBlobThread(p),
    sendToThread: (threadId, text, origin) => engine.sendToBlobThread(threadId, text, origin),
    snapshot: (threadId) => engine.blobThreadSnapshot(threadId),
    runningCount: (blobId) => engine.blobRunningCount(blobId),
    appendCard: (koraThreadId, card) => engine.appendBlobCardByKoraThread(koraThreadId, card),
    queueNote: (koraThreadId, text) => engine.queueBlobNote(koraThreadId, text),
    onSettled: (cb) => engine.onBlobSettled(cb),
    interrupt: (threadId) => engine.interruptBlobThread(threadId),
    startHiddenThread: (p) => engine.startHiddenBlobThread(p),
    createResultsThread: (p) => engine.createBlobResultsThread(p),
    threadExists: (threadId) => engine.blobThreadExists(threadId),
    deleteHiddenThread: async (threadId) => engine.deleteHiddenBlobThread(threadId),
    postRoutineReport: async (threadId, card) => engine.postBlobCardToThread(threadId, card),
    runMemberTurn: (req) => engine.runMemberTurn(req),
    outside: engine.outsideEngine(),
  };
}

/**
 * Subscribe to a blob store's "changed" event whatever its shape: an emitter (`on` returns the emitter, `off` removes),
 * or a store whose `on` returns its own unsubscribe function. Always returns a working unsubscribe.
 */
export function onStoreChanged(store: KoraBlobStoreLike, fn: () => void): () => void {
  const returned = store.on("changed", fn);
  if (typeof returned === "function") return returned as () => void;
  return () => {
    try {
      store.off?.("changed", fn);
    } catch {
      /* already gone */
    }
  };
}
