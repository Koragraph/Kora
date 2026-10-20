import { useCallback, useMemo } from "react";
import { useParams, useRouter } from "@tanstack/react-router";
import { resolveDefaultThreadEnvMode } from "@kora/shared/threadWorkspaceMode";
import { resolveProjectPrefs } from "@kora/shared/projectPrefs";
import {
  type ThreadId,
  type HostThreadRef,
  type HostProjectRef,
  type ModelPick,
  type AgentTurnMode,
  type AccessMode,
  DEFAULT_DAEMON_PREFS,
  DEFAULT_ACCESS_MODE,
} from "@kora/contracts";
import { hostProjectKey, hostProjectRef, hostThreadRef } from "@kora/client-runtime/host";
import { useAtomValue } from "@effect/atom-react";

import { useClientPrefs } from "./usePrefs";
import {
  selectProjectGroupingPrefs,
  getProjectOrderKey,
  deriveLogicalProjectKeyFromPrefs,
} from "../workspace/logicalProject";
import { newDraftId, newThreadId } from "../util/utils";
import { readKoraProjectFileDefaultThreadEnvMode } from "../util/koraProjectFileDefaults";
import {
  resolveNewThreadModelPickOverride,
  resolveNewDraftStartFromOrigin,
  hasExplicitPromptModelPick,
} from "../util/chatThreadActions";
import { threadPageTarget } from "../thread/threadRoutes";
import { legacyProjectCwdPreferenceKey, useViewStateStore } from "../stores/uiStateStore";
import {
  type DraftThreadState,
  type DraftThreadEnvMode,
  type DraftId,
  usePromptDraftStore,
  promptDraftHasUserContent,
  markDraftPromoted,
} from "../stores/promptDraftStore";
import { orderByPreferredIds } from "../components/NavRows.logic";
import { hostDaemonConfigsAtom } from "../atoms/server";
import { readProjects, readThreadSummary, useProjects, useThread } from "../atoms/entities";

type OpenOptions = {
  replace?: boolean;
  startFromOrigin?: boolean;
  envMode?: DraftThreadEnvMode;
  worktreePath?: string | null;
  branch?: string | null;
};

type OpenedDraft = { draftId: DraftId; threadId: ThreadId };

/** The workspace fields a caller named outright; absent keys never overwrite a draft's own. */
function explicitWorkspace(opts: OpenOptions | undefined) {
  const picked: {
    startFromOrigin?: boolean;
    envMode?: DraftThreadEnvMode;
    worktreePath?: string | null;
    branch?: string | null;
  } = {};
  if (opts?.branch !== undefined) picked.branch = opts.branch;
  if (opts?.worktreePath !== undefined) picked.worktreePath = opts.worktreePath;
  if (opts?.envMode !== undefined) picked.envMode = opts.envMode;
  if (opts?.startFromOrigin !== undefined) picked.startFromOrigin = opts.startFromOrigin;
  return picked;
}

export function useStartNewThread(): (
  projKey: HostProjectRef,
  opts?: OpenOptions,
) => Promise<OpenedDraft | null> {
  const router = useRouter();
  const hostConfigs = useAtomValue(hostDaemonConfigsAtom);
  const groupingPrefs = useClientPrefs(selectProjectGroupingPrefs);

  return useCallback(
    async (projKey, opts) => {
      const draftStore = () => usePromptDraftStore.getState();
      const startedAt = router.state.location.href;
      // The user went somewhere else while we were waiting: the request is stale.
      const routeMoved = () => router.state.location.href !== startedAt;
      const replace = opts?.replace ?? false;

      const proj = readProjects().find(
        (candidate) => candidate.hostId === projKey.hostId && candidate.id === projKey.projectId,
      );
      const daemonPrefs = hostConfigs.get(projKey.hostId)?.settings ?? DEFAULT_DAEMON_PREFS;
      const prefsObj = resolveProjectPrefs(daemonPrefs, projKey.projectId, proj);
      const runtimeMode: AccessMode = prefsObj.settings.defaultRuntimeMode ?? DEFAULT_ACCESS_MODE;
      const logicalKey = proj
        ? deriveLogicalProjectKeyFromPrefs(proj, groupingPrefs)
        : hostProjectKey(projKey);
      const explicit = explicitWorkspace(opts);
      const hasExplicit = Object.keys(explicit).length > 0;

      const defaultEnvMode = async (): Promise<DraftThreadEnvMode> => {
        const projectSetting =
          prefsObj.sources.defaultThreadEnvMode === "project"
            ? prefsObj.settings.defaultThreadEnvMode
            : null;
        const projectFile =
          proj && !projectSetting
            ? await readKoraProjectFileDefaultThreadEnvMode(projKey.hostId, proj.workspaceRoot)
            : null;
        return resolveDefaultThreadEnvMode({
          projectSetting,
          projectFile,
          globalDefault: prefsObj.settings.defaultThreadEnvMode,
        });
      };
      const startFromOriginFor = (envMode: DraftThreadEnvMode) =>
        resolveNewDraftStartFromOrigin({
          envMode,
          newWorktreesStartFromOrigin: prefsObj.settings.newWorktreesStartFromOrigin,
        });

      // What is on screen right now (and what a new thread may inherit from it).
      const dest = () =>
        threadPageTarget(
          (router.state.matches.at(-1)?.params ?? {}) as Record<string, string | undefined>,
        );
      const viewedDraftId = (): DraftId | null => {
        const tt = dest();
        return tt?.kind === "draft" ? tt.draftId : null;
      };
      const carried = (() => {
        const tt = dest();
        if (!tt)
          return {
            pick: null as ModelPick | null,
            mode: null as AgentTurnMode | null,
            draftId: null as string | null,
          };
        const composer = draftStore().getComposerDraft(
          tt.kind === "draft" ? tt.draftId : tt.threadRef,
        );
        const sh = tt.kind === "server" ? readThreadSummary(tt.threadRef) : null;
        const sess = tt.kind === "draft" ? draftStore().getDraftSession(tt.draftId) : null;
        const engaged = composer?.activeProvider ?? null;
        const composerPick = engaged ? (composer?.modelSelectionByProvider[engaged] ?? null) : null;
        return {
          pick: composerPick ?? sh?.modelSelection ?? null,
          mode: composer?.interactionMode ?? sh?.interactionMode ?? sess?.interactionMode ?? null,
          draftId: tt.kind === "draft" ? (tt.draftId as string) : null,
        };
      })();

      const open = async (draftKey: DraftId, threadKey: ThreadId): Promise<OpenedDraft> => {
        const onScreen = router.state.location.href.split(/[?#]/)[0] === `/draft/${draftKey}`;
        // No second history entry for a draft that is already showing.
        if (!onScreen) {
          await router.navigate({ to: "/draft/$draftId", params: { draftId: draftKey }, replace });
        }
        return { draftId: draftKey, threadId: threadKey };
      };
      const applyModel = (draftKey: DraftId) => {
        if (hasExplicitPromptModelPick(draftStore().getComposerDraft(draftKey))) return;
        draftStore().applyStickyState(draftKey);
        const override = resolveNewThreadModelPickOverride({
          projectDefaultSelection: prefsObj.settings.defaultModelSelection ?? null,
          carrySelection: carried.pick,
          carrySourceDraftId: carried.draftId,
          destinationDraftId: draftKey,
        });
        if (override) draftStore().setModelSelection(draftKey, override, { replaceOptions: true });
      };
      const sessionHoldsServerThread = (session: { hostId: string; threadId: string }) =>
        readThreadSummary(hostThreadRef(session.hostId as never, session.threadId as never)) !==
        null;
      const presentable = (session: { draftId: string }) =>
        !promptDraftHasUserContent(draftStore().getComposerDraft(session.draftId as DraftId));

      // 1. the draft already filed for this project
      const filed = draftStore().getDraftSessionByLogicalProjectKey(
        logicalKey,
      ) as DraftThreadState | null;
      let reusable: DraftThreadState | null = null;
      let declinedDraftId: string | null = null;
      if (filed) {
        if (filed.promotedTo || sessionHoldsServerThread(filed)) {
          markDraftPromoted(hostThreadRef(filed.hostId, filed.threadId));
          declinedDraftId = filed.draftId;
        } else if (presentable(filed)) {
          reusable = filed;
        } else {
          // Typed text or attachments make it work in progress: keep it, start a fresh one.
          declinedDraftId = filed.draftId;
        }
      }

      // 2. reuse that empty draft
      if (reusable) {
        const draftSession = reusable;
        const alreadyOpen = viewedDraftId() === draftSession.draftId;
        let workspace = explicit;
        if (!hasExplicit && !alreadyOpen) {
          const envMode = await defaultEnvMode();
          if (routeMoved()) return null;
          workspace = {
            branch: null,
            worktreePath: null,
            envMode,
            startFromOrigin: startFromOriginFor(envMode),
          };
        }
        const live = draftStore().getDraftSessionByLogicalProjectKey(
          logicalKey,
        ) as DraftThreadState | null;
        const openedMeanwhile = !alreadyOpen && viewedDraftId() === draftSession.draftId;
        if (
          openedMeanwhile ||
          !live ||
          live.draftId !== draftSession.draftId ||
          live.promotedTo ||
          !presentable(live)
        ) {
          return null;
        }

        const context = {
          ...workspace,
          ...(alreadyOpen ? {} : { runtimeMode }),
          ...(carried.mode ? { interactionMode: carried.mode } : {}),
        };
        draftStore().setDraftThreadContext(draftSession.draftId, context);
        applyModel(draftSession.draftId);
        draftStore().setLogicalProjectDraftThreadId(logicalKey, projKey, draftSession.draftId, {
          threadId: draftSession.threadId,
          ...(alreadyOpen && !hasExplicit
            ? {
                branch: draftSession.branch,
                worktreePath: draftSession.worktreePath,
                envMode: draftSession.envMode,
                startFromOrigin: draftSession.startFromOrigin,
              }
            : {}),
          ...context,
        });
        return open(draftSession.draftId, draftSession.threadId);
      }

      // 3. the empty draft that is on screen
      const shownId = viewedDraftId();
      const shown = shownId
        ? (draftStore().getDraftSession(shownId) as DraftThreadState | null)
        : null;
      if (
        shown &&
        shown.logicalProjectKey === logicalKey &&
        !shown.promotedTo &&
        presentable(shown)
      ) {
        if (hasExplicit) draftStore().setDraftThreadContext(shown.draftId, explicit);
        draftStore().setLogicalProjectDraftThreadId(logicalKey, projKey, shown.draftId, {
          threadId: shown.threadId,
          createdAt: shown.createdAt,
          runtimeMode: shown.runtimeMode,
          interactionMode: shown.interactionMode,
          ...explicit,
        });
        return { draftId: shown.draftId, threadId: shown.threadId };
      }

      // 4. a brand-new draft
      const draftKey = newDraftId();
      const threadKey = newThreadId();
      const envMode = opts?.envMode ?? (await defaultEnvMode());
      if (routeMoved()) return null;

      // Another call may have filed a draft for this project while we waited: adopt its work.
      const winner = draftStore().getDraftSessionByLogicalProjectKey(
        logicalKey,
      ) as DraftThreadState | null;
      if (winner && winner.draftId !== declinedDraftId && !sessionHoldsServerThread(winner)) {
        draftStore().setLogicalProjectDraftThreadId(logicalKey, projKey, winner.draftId, {
          threadId: winner.threadId,
          ...explicit,
        });
        return open(winner.draftId, winner.threadId);
      }

      draftStore().setLogicalProjectDraftThreadId(logicalKey, projKey, draftKey, {
        threadId: threadKey,
        createdAt: new Date().toISOString(),
        branch: opts?.branch ?? null,
        worktreePath: opts?.worktreePath ?? null,
        envMode,
        startFromOrigin: opts?.startFromOrigin ?? startFromOriginFor(envMode),
        runtimeMode,
        ...(carried.mode ? { interactionMode: carried.mode } : {}),
      });
      applyModel(draftKey);
      return open(draftKey, threadKey);
    },
    [groupingPrefs, hostConfigs, router],
  );
}

export function useStartThread() {
  const params = useParams({ strict: false });
  const projects = useProjects();
  const projectOrder = useViewStateStore((state) => state.projectOrder);
  const openNewThread = useStartNewThread();

  const routeTarget = threadPageTarget(params as Record<string, string | undefined>);
  const routeThreadRef: HostThreadRef | null =
    routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeDraftId: DraftId | null = routeTarget?.kind === "draft" ? routeTarget.draftId : null;

  const activeThread = useThread(routeThreadRef);
  const activeDraftThread = usePromptDraftStore((store) =>
    routeThreadRef
      ? store.getDraftThread(routeThreadRef)
      : routeDraftId
        ? store.getDraftSession(routeDraftId)
        : null,
  );

  const defaultProjectRef = useMemo(() => {
    const ranked = orderByPreferredIds({
      getPreferenceIds: (proj) => [
        getProjectOrderKey(proj),
        legacyProjectCwdPreferenceKey(proj.workspaceRoot),
      ],
      getId: getProjectOrderKey,
      preferredIds: projectOrder,
      items: projects,
    });
    const head = ranked[0];
    return head ? hostProjectRef(head.hostId, head.id) : null;
  }, [projectOrder, projects]);

  return {
    routeThreadRef,
    routeDraftId,
    openNewThread,
    defaultProjectRef,
    activeThread,
    activeDraftThread,
  };
}

export function useRetargetDraftProject(): (draftKey: DraftId, projKey: HostProjectRef) => boolean {
  const groupingPrefs = useClientPrefs(selectProjectGroupingPrefs);
  return useCallback(
    (draftKey, projKey) => {
      const draftStore = usePromptDraftStore.getState();
      const draftSession = draftStore.getDraftSession(draftKey);
      if (!draftSession || draftSession.promotedTo) return false;
      const proj = readProjects().find(
        (candidate) => candidate.hostId === projKey.hostId && candidate.id === projKey.projectId,
      );
      const logicalKey = proj
        ? deriveLogicalProjectKeyFromPrefs(proj, groupingPrefs)
        : hostProjectKey(projKey);
      // The store drops branch and worktree on a project change; the typed prompt stays.
      draftStore.setLogicalProjectDraftThreadId(logicalKey, projKey, draftKey, {
        threadId: draftSession.threadId,
        createdAt: draftSession.createdAt,
        runtimeMode: draftSession.runtimeMode,
        interactionMode: draftSession.interactionMode,
        envMode: draftSession.envMode,
      });
      return true;
    },
    [groupingPrefs],
  );
}
