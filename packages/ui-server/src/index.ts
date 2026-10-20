// @effect-diagnostics nodeBuiltinImport:off -- boot-time boundary: resolves the settings file path.
// @effect-diagnostics globalConsole:off globalTimers:off -- boot-time boundary code called by the host kora daemon, not an Effect fiber.
// The chat UI server — loaded INTO `kora server run`. `vp pack` (vite.config.ts) bundles this entry, with Effect
// and @kora/contracts inlined, into kora/ui/ui-server.cjs; kora/src/server/ui.ts requires that file and calls
// `startUiServer` with the daemon's own Runtime + SessionManager. There is no standalone process any more.
import { startEngineProviderSync } from "./enginesProviders.ts";
import * as path from "node:path";

import { applyClaudeModels, autoModelPreselect, setAutoPreselected } from "./claudeModels.ts";
import { notifyAgentsChanged, onAgentsChanged, retryFailedModelProbes } from "./modelRefresh.ts";
import { applyProviderDisplayNames } from "./providerNames.ts";
import { applyCodexModels } from "./codexModels.ts";
import { startAntigravityDetect } from "./antigravityModels.ts";
import { refreshAgentSkills, startSkillWatcher } from "./agentSkills.ts";
import {
  applyOpencodeFreeModels,
  reapplyOpencodeModels,
  bestEngineNow,
  ensureChiefBlob,
  migrateChiefDefaultModel,
  makeBlobEngineBridge,
} from "./blobsEngine.ts";
import { makeBlobNotifier } from "./blobsNotify.ts";
import { wsClientCount } from "./wsClients.ts";
import { type UiHost, setHost } from "./host.ts";
import { setGraphDbOpener } from "./graph.ts";
import { runGraphReaderChild } from "./graphReadWorker.ts";
import { runChatMigration, migrationModeFromEnv } from "./chatMigration.ts";
import { koraSurfaceOn } from "./koraSurface.ts";
import { refreshOpencodeModels } from "./opencodeModels.ts";
import { chatEngine } from "./kora-chat.ts";
import { defaultKoraHome } from "./localAuth.ts";
import { serveUi, type UiServerHandle } from "./server.ts";
import { probeAgentReadiness } from "./agentReadinessInfo.ts";
import { loadPrefs, onPrefsChanged } from "./prefsStore.ts";
import { usageLimits } from "./usageLimits.ts";
import { writeWorkerCatalog } from "./workerCatalog.ts";

export type { UiHost, UiServerHandle };

/** @public Kept for tests and external callers (knip). */
export async function startUiServer(
  host: UiHost,
  opts: { host?: string; port: number; koraHome?: string },
): Promise<UiServerHandle> {
  setHost(host);
  if (host.openGraphDb) setGraphDbOpener((file) => host.openGraphDb!(file));
  // The engine, FleetService and every terminal attach listen on the runtime's notify channel.
  (host.runtime as { setMaxListeners?: (n: number) => unknown }).setMaxListeners?.(500);
  // Auto-detect the Claude + Codex model catalogs before serving, so the connection snapshot carries the real,
  // account-specific models + their per-model effort levels. Both are bounded + best-effort: they never throw and
  // never block beyond their own short timeouts (each falls back to config.ts's static list). The daemon's socket is
  // already serving while this runs.
  const [claudeOk, codexOk] = await Promise.all([applyClaudeModels(), applyCodexModels()]);
  // A failed probe (slow wake, cold spawn) is retried in the background and pushed to open clients when it lands.
  retryFailedModelProbes({ claude: !claudeOk, codex: !codexOk });
  // Real install + login state for Claude/Codex (config.ts starts both as "ready · signed in"). Background: the
  // first snapshot may still say ready; the truth follows as a providerStatuses frame within a few seconds.
  const readiness = probeAgentReadiness();
  // Antigravity (`agy`): the cached model list now, a live `agy models` probe in the background (it takes seconds).
  startAntigravityDetect(opts.koraHome ?? defaultKoraHome());
  // What lead agents may pick workers from (model ids + efforts per CLI), refreshed when a late probe lands.
  const koraHome = opts.koraHome ?? defaultKoraHome();
  writeWorkerCatalog(koraHome);
  onAgentsChanged(() => writeWorkerCatalog(koraHome));
  // Persisted Settings (server.updateSettings) — before the first config snapshot goes out.
  const prefsAtBoot = loadPrefs(path.join(opts.koraHome ?? defaultKoraHome(), "settings.json"));
  // "Name in the picker": the user's provider names on the advertised entries, now and after every change.
  applyProviderDisplayNames();
  // Auto model on (the default): new Claude threads start on Auto; off puts Default back as the preselected row.
  setAutoPreselected(autoModelPreselect(prefsAtBoot.autoModel));
  onPrefsChanged((settings) => {
    const names = applyProviderDisplayNames(settings);
    const auto = setAutoPreselected(autoModelPreselect(settings.autoModel));
    if (names || auto) notifyAgentsChanged();
  });
  onAgentsChanged(() => {
    if (applyProviderDisplayNames()) notifyAgentsChanged();
  });
  // Plan limits: last known numbers now; a fresh read through each CLI once boot has settled (no turn, no tokens).
  usageLimits().init(koraHome);
  // Boot: Claude and Codex only. Antigravity is read when the user opens the usage details (or after an agy turn).
  setTimeout(() => void usageLimits().refresh(["claude", "codex"]), 20_000).unref?.();
  chatEngine(); // hydrate the projection now, not on the first client request
  startEngineProviderSync(); // Phase 7: ACP agents + API endpoints as composer providers
  // Blobs: hand the runtime its bridge to the chat engine (delegated threads, cards, settle events), and keep the
  // free OpenCode provider entry in step with the swarm's free models. Both best-effort: a daemon without blobs skips.
  // Kora is coming soon (koraSurface.ts): no engine bridge (routines, jobs, groups), no blob notifications, no Kora (Chief)
  // and no Chat -> Kora migration (it would make blobs under ~/Blobs; its marker stays absent, so it runs once Kora is
  // on and the old chats/ folder is left exactly as it is until then). The free-model provider sync below is the Code
  // composer's too, so it runs either way.
  const koraOn = koraSurfaceOn();
  if (host.blobs && !koraOn) host.log("[kora-ui] Kora is coming soon: blob work not started");
  if (host.blobs) {
    try {
      host.swarm.onStatus((status) => {
        applyOpencodeFreeModels(status);
      });
      const syncFreeModels = () =>
        void host.swarm.getStatus().then(
          (status) => applyOpencodeFreeModels(status),
          () => {},
        );
      // The user's own OpenCode models (their login, Zen paid, Go, other providers), in a child process.
      const syncListed = () => refreshOpencodeModels(koraHome, reapplyOpencodeModels);
      syncFreeModels();
      setTimeout(syncListed, 5_000).unref?.();
      setInterval(syncListed, 30 * 60_000).unref();
      // The daemon runs for days; Zen's free list changes faster. A status read refreshes the catalog (swarm-setup).
      setInterval(syncFreeModels, 6 * 60 * 60_000).unref();
    } catch (cause) {
      console.warn("[kora-ui] blobs: free-model provider sync unavailable:", String(cause));
    }
  }
  if (host.blobs && koraOn) {
    try {
      host.blobs.attachEngine?.(makeBlobEngineBridge(chatEngine()));
      host.blobs.setBestEngine?.(bestEngineNow);
    } catch (cause) {
      console.warn("[kora-ui] blobs: attachEngine failed:", String(cause));
    }
    // macOS notification when a blob settles / needs the user and the app is closed (QA stacks set KORA_NOTIFY=0).
    try {
      const blobs = host.blobs;
      chatEngine().onBlobAttention(
        makeBlobNotifier({
          clients: wsClientCount,
          nameOf: (id) => blobs.store.get(id)?.name ?? null,
          enabled: () => process.env.KORA_NOTIFY !== "0",
        }),
      );
    } catch (cause) {
      console.warn("[kora-ui] blobs: notifications unavailable:", String(cause));
    }
    // A routine run needs the user / finished / failed: the same quiet notification (generic text, never the routine's title).
    try {
      const blobs = host.blobs;
      const notify = makeBlobNotifier({
        clients: wsClientCount,
        nameOf: (id) => blobs.store.get(id)?.name ?? null,
        enabled: () => process.env.KORA_NOTIFY !== "0",
      });
      blobs.onRoutineAttention?.((e) =>
        notify({ threadId: `routine:${e.blobId}`, blobId: e.blobId, kind: e.kind }),
      );
    } catch (cause) {
      console.warn("[kora-ui] blobs: routine notifications unavailable:", String(cause));
    }
    // Kora (the Chief) is created once the readiness probe says which engines exist (bounded: never blocks boot).
    void Promise.race([
      readiness,
      new Promise<void>((resolve) => setTimeout(resolve, 8_000).unref?.()),
    ]).then(async () => {
      await ensureChiefBlob();
      if (host.blobs) await migrateChiefDefaultModel(host.blobs.store, koraHome);
      // One-time Chat -> Kora move (chatMigration.ts): backed up, journalled, marker-guarded, never deletes anything.
      const blobs = host.blobs;
      if (!blobs) return;
      try {
        const outcome = await runChatMigration({
          home: koraHome,
          blobs,
          engine: chatEngine(),
          mode: migrationModeFromEnv(),
          bestEngine: bestEngineNow,
          log: (m) => host.log(m),
        });
        if (outcome.status !== "already" && outcome.status !== "off")
          host.log(`[kora-ui] chat migration: ${outcome.status}`);
      } catch (cause) {
        host.log(
          `[kora-ui] chat migration failed (will retry at the next start): ${String((cause as Error)?.stack ?? cause)}`,
        );
      }
    });
  }
  // What each agent can run in the folders threads already use (the composer's `$` / `/` skill menus); background.
  // Codex's list is a `codex app-server` spawn: only when a thread already runs on Codex (otherwise the first Codex
  // thread asks for it, `noteSkillCwd`), never at every boot (aud1 S3-7).
  void refreshAgentSkills(chatEngine().threadCwds(), chatEngine().usesDriver("codex"));
  startSkillWatcher();
  // `koraHome` (the daemon's KORA_HOME) holds the UI secret every /ws + /api/* caller must present (localAuth.ts).
  return serveUi({
    host: opts.host ?? "127.0.0.1",
    port: opts.port,
    ...(opts.koraHome ? { koraHome: opts.koraHome } : {}),
  });
}

// The daemon forks this same bundle as the graph reader child (graphReader.ts): a process it can kill when a query hangs.
if (process.env.KORA_GRAPH_READER_CHILD === "1") runGraphReaderChild();
