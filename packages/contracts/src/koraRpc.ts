import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { ExternalLauncherError, LaunchEditorInput } from "./externalEditors.ts";
import { HostAuthorizationError } from "./daemonAccess.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  HostFsBrowseError,
} from "./folderBrowse.ts";
import {
  ChatRpcSchemas,
  ChatSnapshotError,
  ChatDispatchError,
  CHAT_METHODS,
  ClientChatCommand,
} from "./chat.ts";
import {
  ProjectWriteFileResult,
  ProjectWriteFileInput,
  WorkspaceFileWriteError,
  ProjectSearchEntriesResult,
  WorkspaceFindInput,
  WorkspaceFindError,
  ProjectSearchContentsResult,
  WorkspaceGrepInput,
  WorkspaceGrepError,
  WorkspaceFileReadResult,
  ProjectReadFileInput,
  WorkspaceFileReadError,
  WorkspaceListResult,
  ProjectListEntriesInput,
  WorkspaceListError,
} from "./workspaceSearch.ts";
import {
  FleetSubscribeInput,
  FleetStreamEvent,
  FleetSteerInput,
  FleetReadReportResult,
  FleetReadReportInput,
  FleetMergeVerifyInput,
  FleetMergeVerdict,
  FleetMergeResult,
  FleetMergeInput,
  FleetExtendInput,
  FleetRetryInput,
  FleetKillInput,
  FleetSubscribeWorkerInput,
  WorkerFeedStreamEvent,
  FleetRespondApprovalInput,
  FleetError,
  FLEET_METHODS,
} from "./fleet.ts";
import {
  PtyWriteInput,
  PtySessionSnapshot,
  PtyResizeInput,
  PtyOpenInput,
  PtyMetaStreamEvent,
  PtyError,
  PtyCloseInput,
  PtyAttachStreamEvent,
  PtyAttachInput,
} from "./pty.ts";
import {
  WebSessionSnapshot,
  WebResizeInput,
  WebReportStatusInput,
  WebOpenInput,
  WebListResult,
  WebListInput,
  WebEvent,
  WebError,
  WebCloseInput,
} from "./webPreview.ts";
import {
  TeamPreviewInput,
  TeamOptionsResult,
  TeamOptionsInput,
  TeamImportResult,
  TeamImportPlanInput,
  TeamImportPlan,
  TeamImportApplyInput,
  TeamExportResult,
  TeamExportReport,
  TeamExportInput,
  OutsideTokensResult,
  OutsideSetupResult,
  OutsideSetupInput,
  OutsideRevokeResult,
  OutsideRevokeInput,
  OutsideCreateResult,
  OutsideCreateInput,
  OutsideAuditResult,
  OutsideAuditInput,
  OUTSIDE_METHODS,
  GroupsSubscribeInput,
  GroupsStreamEvent,
  GroupWire,
  GroupUpdateInput,
  GroupIdInput,
  GroupCreateInput,
  GroupDeleteInput,
  GROUP_METHODS,
} from "./blobsGroups.ts";
import {
  EnginesView,
  EnginesListInput,
  EnginesDoResult,
  EnginesDoInput,
  ENGINE_METHODS,
} from "./engines.ts";
import {
  DaemonConfigStreamEvent,
  DaemonConfig,
  DaemonLifecycleStreamEvent,
} from "./daemonConfig.ts";
import { DaemonPrefs, DaemonPrefsError, DaemonPrefsPatch } from "./clientPrefs.ts";
import {
  SwarmTestProviderInput,
  SwarmSubscribeInput,
  SwarmStreamEvent,
  SwarmStatus,
  SwarmSetPreferencesInput,
  SwarmSetKeyInput,
  SwarmSetConsentInput,
  SwarmProviderStatus,
  SwarmPreferences,
  SwarmOperationError,
  SwarmInstallState,
  SwarmInstallStartInput,
  SwarmInstallCancelInput,
  SwarmGetStatusInput,
  SwarmConsentState,
  SwarmClearKeyInput,
  SWARM_METHODS,
} from "./swarm.ts";
import {
  MemoryReceipt,
  JobCardPayload,
  BlobsSubscribeInput,
  BlobsStreamEvent,
  BlobsSnapshot,
  BlobsListInput,
  BlobUsage,
  BlobUpdateInput,
  BlobTemplates,
  BlobSetTextInput,
  BlobProfile,
  BlobConfirmResolveResult,
  BlobConfirmResolveInput,
  BlobProposalDismissInput,
  BlobMemoryUndoInput,
  BlobMemorySetCoreInput,
  BlobMemorySearchResult,
  BlobMemorySearchInput,
  BlobMemoryListInput,
  BlobMemoryList,
  BlobMemoryImportantInput,
  BlobMemoryFactInput,
  BlobMemoryEditInput,
  BlobMemoryCore,
  BlobMemoryConfirmInput,
  BlobJobGetInput,
  BlobJobFeedbackInput,
  BlobJobCancelInput,
  BlobIdInput,
  BlobHired,
  BlobHireTemplatesInput,
  BlobFlags,
  BlobFlagInput,
  BlobFilesInput,
  BlobFiles,
  BlobFact,
  BlobError,
  BlobEmptyResult,
  BlobDetail,
  BlobDeleteInput,
  BlobDefaults,
  BlobCreateInput,
  BlobContinueOnFreeResult,
  BlobUndoSelfChangeResult,
  BlobUndoSelfChangeInput,
  BlobContinueOnFreeInput,
  BlobAboutMe,
  RoutinesSubscribeInput,
  RoutinesSnapshot,
  RoutinesChangedEvent,
  RoutineWire,
  RoutineTriggerSecret,
  RoutineTriggerIdInput,
  RoutineThreadsResult,
  RoutineSetPausedInput,
  RoutineSaveInput,
  RoutineRunNowResult,
  RoutineRunIdInput,
  RoutinePreviewResult,
  RoutinePreviewInput,
  RoutineIdInput,
  RoutineCreateTriggerInput,
  RoutineConfirmInput,
  RoutineConfirmCardPayload,
  AppsToolsResult,
  AppsToolsInput,
  AppsToolkitsResult,
  AppsToolkitsInput,
  AppsStatus,
  AppsSetKeyInput,
  AppsDisconnectResult,
  AppsDisconnectInput,
  AppsDecisionsResult,
  AppsDecisionsInput,
  AppsConnectResult,
  AppsConnectInput,
  AppsAccountsResult,
  AppsAccountsInput,
  BLOB_METHODS,
} from "./blobs.ts";
import {
  TrustSetInput,
  TrustOperationError,
  TrustListResult,
  TrustGetInput,
  TRUST_METHODS,
  FolderTrustStatus,
} from "./trust.ts";
import * as Ext from "./extensions.ts";

export const RPC_METHODS = {
  // Project registry methods
  filesList: "workspace.files.list",
  filesRead: "workspace.files.read",
  filesGrep: "workspace.grep",
  filesFind: "workspace.files.find",
  filesWrite: "workspace.files.write",

  // Shell methods
  editorOpen: "host.editor.open",

  // Filesystem methods
  fsBrowse: "host.fs.browse",

  // Provider methods

  // VCS methods

  // Git workflow methods

  // Review methods

  // Terminal methods
  ptyOpen: "pty.open",
  ptyAttach: "pty.attach",
  ptyWrite: "pty.write",
  ptyResize: "pty.resize",
  ptyClose: "pty.close",

  // Preview methods
  browserOpen: "browser.open",
  browserResize: "browser.resize",
  browserClose: "browser.close",
  browserList: "browser.list",
  browserReportStatus: "browser.reportStatus",

  // Device methods

  // Server meta
  daemonProbe: "daemon.probe",
  daemonConfigGet: "daemon.config.get",
  daemonPrefsUpdate: "daemon.prefs.update",

  // Cloud environment methods

  // Pull request methods

  // Source control methods

  // Streaming subscriptions
  ptyWatchMeta: "pty.watchMeta",
  // Fleet (orchestrator threads): live worker roster + steering/merge actions.
  fleetSubscribe: FLEET_METHODS.subscribe,
  fleetSteer: FLEET_METHODS.steer,
  fleetKill: FLEET_METHODS.kill,
  fleetRetry: FLEET_METHODS.retry,
  fleetExtend: FLEET_METHODS.extend,
  fleetMergeVerify: FLEET_METHODS.mergeVerify,
  fleetMerge: FLEET_METHODS.merge,
  fleetReadReport: FLEET_METHODS.readReport,
  fleetSubscribeWorker: FLEET_METHODS.subscribeWorker,
  fleetRespondApproval: FLEET_METHODS.respondApproval,
  // Swarm setup (readiness / OpenCode install / keys / probes / consent / preferences).
  swarmSubscribe: SWARM_METHODS.subscribe,
  swarmGetStatus: SWARM_METHODS.getStatus,
  swarmInstallStart: SWARM_METHODS.installStart,
  swarmInstallCancel: SWARM_METHODS.installCancel,
  swarmSetKey: SWARM_METHODS.setKey,
  swarmClearKey: SWARM_METHODS.clearKey,
  swarmTestProvider: SWARM_METHODS.testProvider,
  swarmSetConsent: SWARM_METHODS.setConsent,
  swarmSetPreferences: SWARM_METHODS.setPreferences,
  // Blobs: persistent AI coworker agents (roster, profile, memory, about-me, defaults, usage, jobs).
  blobsSubscribe: BLOB_METHODS.subscribe,
  blobsList: BLOB_METHODS.list,
  blobsGet: BLOB_METHODS.get,
  blobsCreate: BLOB_METHODS.create,
  blobsUpdate: BLOB_METHODS.update,
  blobsSetSoul: BLOB_METHODS.setSoul,
  blobsArchive: BLOB_METHODS.archive,
  blobsRehire: BLOB_METHODS.rehire,
  blobsDelete: BLOB_METHODS.delete,
  blobsDuplicate: BLOB_METHODS.duplicate,
  blobsGetAboutMe: BLOB_METHODS.getAboutMe,
  blobsSetAboutMe: BLOB_METHODS.setAboutMe,
  blobsGetDefaults: BLOB_METHODS.getDefaults,
  blobsSetDefaults: BLOB_METHODS.setDefaults,
  blobsSetFlag: BLOB_METHODS.setFlag,
  blobsUsage: BLOB_METHODS.usage,
  blobsFiles: BLOB_METHODS.files,
  blobsMemoryList: BLOB_METHODS.memoryList,
  blobsMemoryEdit: BLOB_METHODS.memoryEdit,
  blobsMemoryForget: BLOB_METHODS.memoryForget,
  blobsMemoryImportant: BLOB_METHODS.memoryImportant,
  blobsMemoryUndo: BLOB_METHODS.memoryUndo,
  blobsMemoryConfirm: BLOB_METHODS.memoryConfirm,
  blobsMemorySetCore: BLOB_METHODS.memorySetCore,
  blobsMemorySearch: BLOB_METHODS.memorySearch,
  blobsTemplates: BLOB_METHODS.templates,
  blobsHireTemplates: BLOB_METHODS.hireTemplates,
  blobsJobGet: BLOB_METHODS.jobGet,
  blobsJobCancel: BLOB_METHODS.jobCancel,
  blobsJobFeedback: BLOB_METHODS.jobFeedback,
  blobsProposalDismiss: BLOB_METHODS.proposalDismiss,
  blobsConfirmResolve: BLOB_METHODS.confirmResolve,
  blobsContinueOnFree: BLOB_METHODS.continueOnFree,
  blobsUndoSelfChange: BLOB_METHODS.undoSelfChange,
  blobsRoutinesSnapshot: BLOB_METHODS.routinesSnapshot,
  blobsRoutinesSubscribe: BLOB_METHODS.routinesSubscribe,
  blobsRoutinesThreads: BLOB_METHODS.routinesThreads,
  blobsRoutinesPreview: BLOB_METHODS.routinesPreview,
  blobsRoutinesSave: BLOB_METHODS.routinesSave,
  blobsRoutinesSetPaused: BLOB_METHODS.routinesSetPaused,
  blobsRoutinesRemove: BLOB_METHODS.routinesRemove,
  blobsRoutinesRunNow: BLOB_METHODS.routinesRunNow,
  blobsRoutinesCancelRun: BLOB_METHODS.routinesCancelRun,
  blobsRoutinesCreateTrigger: BLOB_METHODS.routinesCreateTrigger,
  blobsRoutinesRotateTrigger: BLOB_METHODS.routinesRotateTrigger,
  blobsRoutinesDeleteTrigger: BLOB_METHODS.routinesDeleteTrigger,
  blobsRoutinesConfirm: BLOB_METHODS.routinesConfirm,
  blobsAppsStatus: BLOB_METHODS.appsStatus,
  blobsAppsSetKey: BLOB_METHODS.appsSetKey,
  blobsAppsClearKey: BLOB_METHODS.appsClearKey,
  blobsAppsResetBroker: BLOB_METHODS.appsResetBroker,
  blobsAppsToolkits: BLOB_METHODS.appsToolkits,
  blobsAppsAccounts: BLOB_METHODS.appsAccounts,
  blobsAppsConnect: BLOB_METHODS.appsConnect,
  blobsAppsDisconnect: BLOB_METHODS.appsDisconnect,
  blobsAppsTools: BLOB_METHODS.appsTools,
  blobsAppsDecisions: BLOB_METHODS.appsDecisions,
  // Phase 7: Settings > Engines (ACP agents, API endpoints, Claude accounts).
  enginesList: ENGINE_METHODS.list,
  enginesDo: ENGINE_METHODS.do,
  // Phase 3: group chats + team files; Phase 8: outside access.
  blobsGroupsSubscribe: GROUP_METHODS.subscribe,
  blobsGroupsCreate: GROUP_METHODS.create,
  blobsGroupsUpdate: GROUP_METHODS.update,
  blobsGroupsArchive: GROUP_METHODS.archive,
  blobsGroupsDelete: GROUP_METHODS.delete,
  blobsTeamOptions: GROUP_METHODS.teamOptions,
  blobsTeamPreview: GROUP_METHODS.teamPreview,
  blobsTeamExport: GROUP_METHODS.teamExport,
  blobsTeamImportPlan: GROUP_METHODS.teamImportPlan,
  blobsTeamImportApply: GROUP_METHODS.teamImportApply,
  blobsOutsideSetup: OUTSIDE_METHODS.setup,
  blobsOutsideTokens: OUTSIDE_METHODS.tokens,
  blobsOutsideCreate: OUTSIDE_METHODS.create,
  blobsOutsideRevoke: OUTSIDE_METHODS.revoke,
  blobsOutsideAudit: OUTSIDE_METHODS.audit,
  // Folder trust: may agents run a folder's own config (hooks, project MCP servers, plugins, tools)?
  trustGet: TRUST_METHODS.get,
  trustSet: TRUST_METHODS.set,
  trustList: TRUST_METHODS.list,
  // Extensions: MCP servers and skills every agent gets (Settings › Extensions, `kora ext`).
  extensionsList: Ext.EXTENSIONS_METHODS.list,
  extensionsSave: Ext.EXTENSIONS_METHODS.save,
  extensionsRemove: Ext.EXTENSIONS_METHODS.remove,
  extensionsSetEnabled: Ext.EXTENSIONS_METHODS.setEnabled,
  extensionsTest: Ext.EXTENSIONS_METHODS.test,
  extensionsParse: Ext.EXTENSIONS_METHODS.parse,
  extensionsDiscover: Ext.EXTENSIONS_METHODS.discover,
  extensionsCatalog: Ext.EXTENSIONS_METHODS.catalog,
  extensionsAddFromCatalog: Ext.EXTENSIONS_METHODS.addFromCatalog,
  extensionsProject: Ext.EXTENSIONS_METHODS.project,
  extensionsProjectApprove: Ext.EXTENSIONS_METHODS.projectApprove,
  extensionsSkillAdd: Ext.EXTENSIONS_METHODS.skillAdd,
  extensionsSkillRemove: Ext.EXTENSIONS_METHODS.skillRemove,
  extensionsSkillSetEnabled: Ext.EXTENSIONS_METHODS.skillSetEnabled,
  extensionsSetProjectSecret: Ext.EXTENSIONS_METHODS.setProjectSecret,
  browserWatch: "browser.watch",
  subscribeDaemonConfig: "subscribeDaemonConfig",
  subscribeDaemonLifecycle: "subscribeDaemonLifecycle",
} as const;

const DaemonProbeRpc = Rpc.make(RPC_METHODS.daemonProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: HostAuthorizationError,
});

const DaemonGetConfigRpc = Rpc.make(RPC_METHODS.daemonConfigGet, {
  payload: Schema.Struct({}),
  success: DaemonConfig,
  error: Schema.Union([DaemonPrefsError, HostAuthorizationError]),
});

const DaemonUpdatePrefsRpc = Rpc.make(RPC_METHODS.daemonPrefsUpdate, {
  payload: Schema.Struct({ patch: DaemonPrefsPatch }),
  success: DaemonPrefs,
  error: Schema.Union([DaemonPrefsError, HostAuthorizationError]),
});

// Clone-backed project creation. `start` returns once the project exists and
// the clone is running; progress arrives on the subscription.

const ProjectsSearchEntriesRpc = Rpc.make(RPC_METHODS.filesFind, {
  payload: WorkspaceFindInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([WorkspaceFindError, HostAuthorizationError]),
});

const ProjectsSearchContentsRpc = Rpc.make(RPC_METHODS.filesGrep, {
  payload: WorkspaceGrepInput,
  success: ProjectSearchContentsResult,
  error: Schema.Union([WorkspaceGrepError, HostAuthorizationError]),
});

const ProjectsListEntriesRpc = Rpc.make(RPC_METHODS.filesList, {
  payload: ProjectListEntriesInput,
  success: WorkspaceListResult,
  error: Schema.Union([WorkspaceListError, HostAuthorizationError]),
});

const ProjectsReadFileRpc = Rpc.make(RPC_METHODS.filesRead, {
  payload: ProjectReadFileInput,
  success: WorkspaceFileReadResult,
  error: Schema.Union([WorkspaceFileReadError, HostAuthorizationError]),
});

const ProjectsWriteFileRpc = Rpc.make(RPC_METHODS.filesWrite, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([WorkspaceFileWriteError, HostAuthorizationError]),
});

const ShellOpenInEditorRpc = Rpc.make(RPC_METHODS.editorOpen, {
  payload: LaunchEditorInput,
  error: Schema.Union([ExternalLauncherError, HostAuthorizationError]),
});

const FilesystemBrowseRpc = Rpc.make(RPC_METHODS.fsBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([HostFsBrowseError, HostAuthorizationError]),
});

const TerminalOpenRpc = Rpc.make(RPC_METHODS.ptyOpen, {
  payload: PtyOpenInput,
  success: PtySessionSnapshot,
  error: Schema.Union([PtyError, HostAuthorizationError]),
});

const TerminalAttachRpc = Rpc.make(RPC_METHODS.ptyAttach, {
  payload: PtyAttachInput,
  success: PtyAttachStreamEvent,
  error: Schema.Union([PtyError, HostAuthorizationError]),
  stream: true,
});

const TerminalWriteRpc = Rpc.make(RPC_METHODS.ptyWrite, {
  payload: PtyWriteInput,
  error: Schema.Union([PtyError, HostAuthorizationError]),
});

const TerminalResizeRpc = Rpc.make(RPC_METHODS.ptyResize, {
  payload: PtyResizeInput,
  error: Schema.Union([PtyError, HostAuthorizationError]),
});

const TerminalCloseRpc = Rpc.make(RPC_METHODS.ptyClose, {
  payload: PtyCloseInput,
  error: Schema.Union([PtyError, HostAuthorizationError]),
});

const WebOpenRpc = Rpc.make(RPC_METHODS.browserOpen, {
  payload: WebOpenInput,
  success: WebSessionSnapshot,
  error: Schema.Union([WebError, HostAuthorizationError]),
});

const WebResizeRpc = Rpc.make(RPC_METHODS.browserResize, {
  payload: WebResizeInput,
  success: WebSessionSnapshot,
  error: Schema.Union([WebError, HostAuthorizationError]),
});

const WebCloseRpc = Rpc.make(RPC_METHODS.browserClose, {
  payload: WebCloseInput,
  error: Schema.Union([WebError, HostAuthorizationError]),
});

const WebListRpc = Rpc.make(RPC_METHODS.browserList, {
  payload: WebListInput,
  success: WebListResult,
  error: HostAuthorizationError,
});

const WebReportStatusRpc = Rpc.make(RPC_METHODS.browserReportStatus, {
  payload: WebReportStatusInput,
  error: Schema.Union([WebError, HostAuthorizationError]),
});

const SubscribeWebEventsRpc = Rpc.make(RPC_METHODS.browserWatch, {
  payload: Schema.Struct({}),
  success: WebEvent,
  error: HostAuthorizationError,
  stream: true,
});

const ChatDispatchRpc = Rpc.make(CHAT_METHODS.dispatch, {
  payload: ClientChatCommand,
  success: ChatRpcSchemas.dispatchCommand.output,
  error: Schema.Union([ChatDispatchError, HostAuthorizationError]),
});

const ChatListArchivedThreadsRpc = Rpc.make(CHAT_METHODS.listArchivedThreads, {
  payload: ChatRpcSchemas.getArchivedShellSnapshot.input,
  success: ChatRpcSchemas.getArchivedShellSnapshot.output,
  error: Schema.Union([ChatSnapshotError, HostAuthorizationError]),
});

const ChatSubscribeThreadsRpc = Rpc.make(CHAT_METHODS.subscribeThreads, {
  payload: ChatRpcSchemas.subscribeShell.input,
  success: ChatRpcSchemas.subscribeShell.output,
  error: Schema.Union([ChatSnapshotError, HostAuthorizationError]),
  stream: true,
});

const ChatSubscribeThreadRpc = Rpc.make(CHAT_METHODS.subscribeThread, {
  payload: ChatRpcSchemas.subscribeThread.input,
  success: ChatRpcSchemas.subscribeThread.output,
  error: Schema.Union([ChatSnapshotError, HostAuthorizationError]),
  stream: true,
});

const SubscribeTerminalMetadataRpc = Rpc.make(RPC_METHODS.ptyWatchMeta, {
  payload: Schema.Struct({}),
  success: PtyMetaStreamEvent,
  error: HostAuthorizationError,
  stream: true,
});

const FleetSubscribeRpc = Rpc.make(RPC_METHODS.fleetSubscribe, {
  payload: FleetSubscribeInput,
  success: FleetStreamEvent,
  error: Schema.Union([FleetError, HostAuthorizationError]),
  stream: true,
});
const FleetSteerRpc = Rpc.make(RPC_METHODS.fleetSteer, {
  payload: FleetSteerInput,
  error: Schema.Union([FleetError, HostAuthorizationError]),
});
const FleetKillRpc = Rpc.make(RPC_METHODS.fleetKill, {
  payload: FleetKillInput,
  error: Schema.Union([FleetError, HostAuthorizationError]),
});
const FleetRetryRpc = Rpc.make(RPC_METHODS.fleetRetry, {
  payload: FleetRetryInput,
  error: Schema.Union([FleetError, HostAuthorizationError]),
});
const FleetExtendRpc = Rpc.make(RPC_METHODS.fleetExtend, {
  payload: FleetExtendInput,
  error: Schema.Union([FleetError, HostAuthorizationError]),
});
const FleetMergeVerifyRpc = Rpc.make(RPC_METHODS.fleetMergeVerify, {
  payload: FleetMergeVerifyInput,
  success: FleetMergeVerdict,
  error: Schema.Union([FleetError, HostAuthorizationError]),
});
const FleetMergeRpc = Rpc.make(RPC_METHODS.fleetMerge, {
  payload: FleetMergeInput,
  success: FleetMergeResult,
  error: Schema.Union([FleetError, HostAuthorizationError]),
});
const FleetReadReportRpc = Rpc.make(RPC_METHODS.fleetReadReport, {
  payload: FleetReadReportInput,
  success: FleetReadReportResult,
  error: Schema.Union([FleetError, HostAuthorizationError]),
});

const FleetSubscribeWorkerRpc = Rpc.make(RPC_METHODS.fleetSubscribeWorker, {
  payload: FleetSubscribeWorkerInput,
  success: WorkerFeedStreamEvent,
  error: Schema.Union([FleetError, HostAuthorizationError]),
  stream: true,
});
const FleetRespondApprovalRpc = Rpc.make(RPC_METHODS.fleetRespondApproval, {
  payload: FleetRespondApprovalInput,
  error: Schema.Union([FleetError, HostAuthorizationError]),
});

const SwarmRpcError = Schema.Union([SwarmOperationError, HostAuthorizationError]);

const SwarmSubscribeRpc = Rpc.make(RPC_METHODS.swarmSubscribe, {
  payload: SwarmSubscribeInput,
  success: SwarmStreamEvent,
  error: SwarmRpcError,
  stream: true,
});
const SwarmGetStatusRpc = Rpc.make(RPC_METHODS.swarmGetStatus, {
  payload: SwarmGetStatusInput,
  success: SwarmStatus,
  error: SwarmRpcError,
});
const SwarmInstallStartRpc = Rpc.make(RPC_METHODS.swarmInstallStart, {
  payload: SwarmInstallStartInput,
  success: SwarmInstallState,
  error: SwarmRpcError,
});
const SwarmInstallCancelRpc = Rpc.make(RPC_METHODS.swarmInstallCancel, {
  payload: SwarmInstallCancelInput,
  success: SwarmInstallState,
  error: SwarmRpcError,
});
const SwarmSetKeyRpc = Rpc.make(RPC_METHODS.swarmSetKey, {
  payload: SwarmSetKeyInput,
  success: SwarmProviderStatus,
  error: SwarmRpcError,
});
const SwarmClearKeyRpc = Rpc.make(RPC_METHODS.swarmClearKey, {
  payload: SwarmClearKeyInput,
  success: SwarmProviderStatus,
  error: SwarmRpcError,
});
const SwarmTestProviderRpc = Rpc.make(RPC_METHODS.swarmTestProvider, {
  payload: SwarmTestProviderInput,
  success: SwarmProviderStatus,
  error: SwarmRpcError,
});
const SwarmSetConsentRpc = Rpc.make(RPC_METHODS.swarmSetConsent, {
  payload: SwarmSetConsentInput,
  success: SwarmConsentState,
  error: SwarmRpcError,
});
const SwarmSetPreferencesRpc = Rpc.make(RPC_METHODS.swarmSetPreferences, {
  payload: SwarmSetPreferencesInput,
  success: SwarmPreferences,
  error: SwarmRpcError,
});

const BlobsRpcError = Schema.Union([BlobError, HostAuthorizationError]);
const BlobsSubscribeRpc = Rpc.make(RPC_METHODS.blobsSubscribe, {
  payload: BlobsSubscribeInput,
  success: BlobsStreamEvent,
  error: BlobsRpcError,
  stream: true,
});
const BlobsListRpc = Rpc.make(RPC_METHODS.blobsList, {
  payload: BlobsListInput,
  success: BlobsSnapshot,
  error: BlobsRpcError,
});
const BlobsGetRpc = Rpc.make(RPC_METHODS.blobsGet, {
  payload: BlobIdInput,
  success: BlobDetail,
  error: BlobsRpcError,
});
const BlobsCreateRpc = Rpc.make(RPC_METHODS.blobsCreate, {
  payload: BlobCreateInput,
  success: BlobProfile,
  error: BlobsRpcError,
});
const BlobsUpdateRpc = Rpc.make(RPC_METHODS.blobsUpdate, {
  payload: BlobUpdateInput,
  success: BlobProfile,
  error: BlobsRpcError,
});
const BlobsSetSoulRpc = Rpc.make(RPC_METHODS.blobsSetSoul, {
  payload: BlobSetTextInput,
  success: BlobDetail,
  error: BlobsRpcError,
});
const BlobsArchiveRpc = Rpc.make(RPC_METHODS.blobsArchive, {
  payload: BlobIdInput,
  success: BlobProfile,
  error: BlobsRpcError,
});
const BlobsRehireRpc = Rpc.make(RPC_METHODS.blobsRehire, {
  payload: BlobIdInput,
  success: BlobProfile,
  error: BlobsRpcError,
});
const BlobsDeleteRpc = Rpc.make(RPC_METHODS.blobsDelete, {
  payload: BlobDeleteInput,
  success: BlobEmptyResult,
  error: BlobsRpcError,
});
const BlobsDuplicateRpc = Rpc.make(RPC_METHODS.blobsDuplicate, {
  payload: BlobIdInput,
  success: BlobProfile,
  error: BlobsRpcError,
});
const BlobsGetAboutMeRpc = Rpc.make(RPC_METHODS.blobsGetAboutMe, {
  payload: BlobsListInput,
  success: BlobAboutMe,
  error: BlobsRpcError,
});
const BlobsSetAboutMeRpc = Rpc.make(RPC_METHODS.blobsSetAboutMe, {
  payload: BlobAboutMe,
  success: BlobAboutMe,
  error: BlobsRpcError,
});
const BlobsGetDefaultsRpc = Rpc.make(RPC_METHODS.blobsGetDefaults, {
  payload: BlobsListInput,
  success: BlobDefaults,
  error: BlobsRpcError,
});
const BlobsSetDefaultsRpc = Rpc.make(RPC_METHODS.blobsSetDefaults, {
  payload: BlobDefaults,
  success: BlobDefaults,
  error: BlobsRpcError,
});
const BlobsSetFlagRpc = Rpc.make(RPC_METHODS.blobsSetFlag, {
  payload: BlobFlagInput,
  success: BlobFlags,
  error: BlobsRpcError,
});
const BlobsUsageRpc = Rpc.make(RPC_METHODS.blobsUsage, {
  payload: BlobIdInput,
  success: BlobUsage,
  error: BlobsRpcError,
});
const BlobsFilesRpc = Rpc.make(RPC_METHODS.blobsFiles, {
  payload: BlobFilesInput,
  success: BlobFiles,
  error: BlobsRpcError,
});
const BlobsMemoryListRpc = Rpc.make(RPC_METHODS.blobsMemoryList, {
  payload: BlobMemoryListInput,
  success: BlobMemoryList,
  error: BlobsRpcError,
});
const BlobsMemoryEditRpc = Rpc.make(RPC_METHODS.blobsMemoryEdit, {
  payload: BlobMemoryEditInput,
  success: BlobFact,
  error: BlobsRpcError,
});
const BlobsMemoryForgetRpc = Rpc.make(RPC_METHODS.blobsMemoryForget, {
  payload: BlobMemoryFactInput,
  success: BlobFact,
  error: BlobsRpcError,
});
const BlobsMemoryImportantRpc = Rpc.make(RPC_METHODS.blobsMemoryImportant, {
  payload: BlobMemoryImportantInput,
  success: BlobFact,
  error: BlobsRpcError,
});
const BlobsMemoryUndoRpc = Rpc.make(RPC_METHODS.blobsMemoryUndo, {
  payload: BlobMemoryUndoInput,
  success: MemoryReceipt,
  error: BlobsRpcError,
});
const BlobsMemoryConfirmRpc = Rpc.make(RPC_METHODS.blobsMemoryConfirm, {
  payload: BlobMemoryConfirmInput,
  success: MemoryReceipt,
  error: BlobsRpcError,
});
const BlobsMemorySetCoreRpc = Rpc.make(RPC_METHODS.blobsMemorySetCore, {
  payload: BlobMemorySetCoreInput,
  success: BlobMemoryCore,
  error: BlobsRpcError,
});
const BlobsMemorySearchRpc = Rpc.make(RPC_METHODS.blobsMemorySearch, {
  payload: BlobMemorySearchInput,
  success: BlobMemorySearchResult,
  error: BlobsRpcError,
});
const BlobsTemplatesRpc = Rpc.make(RPC_METHODS.blobsTemplates, {
  payload: BlobsListInput,
  success: BlobTemplates,
  error: BlobsRpcError,
});
const BlobsHireTemplatesRpc = Rpc.make(RPC_METHODS.blobsHireTemplates, {
  payload: BlobHireTemplatesInput,
  success: BlobHired,
  error: BlobsRpcError,
});
const BlobsJobGetRpc = Rpc.make(RPC_METHODS.blobsJobGet, {
  payload: BlobJobGetInput,
  success: JobCardPayload,
  error: BlobsRpcError,
});
const BlobsJobCancelRpc = Rpc.make(RPC_METHODS.blobsJobCancel, {
  payload: BlobJobCancelInput,
  success: JobCardPayload,
  error: BlobsRpcError,
});
const BlobsJobFeedbackRpc = Rpc.make(RPC_METHODS.blobsJobFeedback, {
  payload: BlobJobFeedbackInput,
  success: BlobEmptyResult,
  error: BlobsRpcError,
});
const BlobsProposalDismissRpc = Rpc.make(RPC_METHODS.blobsProposalDismiss, {
  payload: BlobProposalDismissInput,
  success: BlobEmptyResult,
  error: BlobsRpcError,
});
const BlobsConfirmResolveRpc = Rpc.make(RPC_METHODS.blobsConfirmResolve, {
  payload: BlobConfirmResolveInput,
  success: BlobConfirmResolveResult,
  error: BlobsRpcError,
});
const BlobsUndoSelfChangeRpc = Rpc.make(RPC_METHODS.blobsUndoSelfChange, {
  payload: BlobUndoSelfChangeInput,
  success: BlobUndoSelfChangeResult,
  error: BlobsRpcError,
});
const BlobsContinueOnFreeRpc = Rpc.make(RPC_METHODS.blobsContinueOnFree, {
  payload: BlobContinueOnFreeInput,
  success: BlobContinueOnFreeResult,
  error: BlobsRpcError,
});

const BlobsRoutinesSnapshotRpc = Rpc.make(RPC_METHODS.blobsRoutinesSnapshot, {
  payload: BlobIdInput,
  success: RoutinesSnapshot,
  error: BlobsRpcError,
});
const BlobsRoutinesSubscribeRpc = Rpc.make(RPC_METHODS.blobsRoutinesSubscribe, {
  payload: RoutinesSubscribeInput,
  success: RoutinesChangedEvent,
  error: BlobsRpcError,
  stream: true,
});
const BlobsRoutinesThreadsRpc = Rpc.make(RPC_METHODS.blobsRoutinesThreads, {
  payload: BlobIdInput,
  success: RoutineThreadsResult,
  error: BlobsRpcError,
});
const BlobsRoutinesPreviewRpc = Rpc.make(RPC_METHODS.blobsRoutinesPreview, {
  payload: RoutinePreviewInput,
  success: RoutinePreviewResult,
  error: BlobsRpcError,
});
const BlobsRoutinesSaveRpc = Rpc.make(RPC_METHODS.blobsRoutinesSave, {
  payload: RoutineSaveInput,
  success: RoutineWire,
  error: BlobsRpcError,
});
const BlobsRoutinesSetPausedRpc = Rpc.make(RPC_METHODS.blobsRoutinesSetPaused, {
  payload: RoutineSetPausedInput,
  success: RoutineWire,
  error: BlobsRpcError,
});
const BlobsRoutinesRemoveRpc = Rpc.make(RPC_METHODS.blobsRoutinesRemove, {
  payload: RoutineIdInput,
  success: BlobEmptyResult,
  error: BlobsRpcError,
});
const BlobsRoutinesRunNowRpc = Rpc.make(RPC_METHODS.blobsRoutinesRunNow, {
  payload: RoutineIdInput,
  success: RoutineRunNowResult,
  error: BlobsRpcError,
});
const BlobsRoutinesCancelRunRpc = Rpc.make(RPC_METHODS.blobsRoutinesCancelRun, {
  payload: RoutineRunIdInput,
  success: BlobEmptyResult,
  error: BlobsRpcError,
});
const BlobsRoutinesCreateTriggerRpc = Rpc.make(RPC_METHODS.blobsRoutinesCreateTrigger, {
  payload: RoutineCreateTriggerInput,
  success: RoutineTriggerSecret,
  error: BlobsRpcError,
});
const BlobsRoutinesRotateTriggerRpc = Rpc.make(RPC_METHODS.blobsRoutinesRotateTrigger, {
  payload: RoutineTriggerIdInput,
  success: RoutineTriggerSecret,
  error: BlobsRpcError,
});
const BlobsRoutinesDeleteTriggerRpc = Rpc.make(RPC_METHODS.blobsRoutinesDeleteTrigger, {
  payload: RoutineTriggerIdInput,
  success: BlobEmptyResult,
  error: BlobsRpcError,
});
const BlobsRoutinesConfirmRpc = Rpc.make(RPC_METHODS.blobsRoutinesConfirm, {
  payload: RoutineConfirmInput,
  success: RoutineConfirmCardPayload,
  error: BlobsRpcError,
});
const BlobsAppsStatusRpc = Rpc.make(RPC_METHODS.blobsAppsStatus, {
  payload: BlobsListInput,
  success: AppsStatus,
  error: BlobsRpcError,
});
const BlobsAppsSetKeyRpc = Rpc.make(RPC_METHODS.blobsAppsSetKey, {
  payload: AppsSetKeyInput,
  success: AppsStatus,
  error: BlobsRpcError,
});
const BlobsAppsClearKeyRpc = Rpc.make(RPC_METHODS.blobsAppsClearKey, {
  payload: BlobsListInput,
  success: AppsStatus,
  error: BlobsRpcError,
});
const BlobsAppsResetBrokerRpc = Rpc.make(RPC_METHODS.blobsAppsResetBroker, {
  payload: BlobsListInput,
  success: AppsStatus,
  error: BlobsRpcError,
});
const BlobsAppsToolkitsRpc = Rpc.make(RPC_METHODS.blobsAppsToolkits, {
  payload: AppsToolkitsInput,
  success: AppsToolkitsResult,
  error: BlobsRpcError,
});
const BlobsAppsAccountsRpc = Rpc.make(RPC_METHODS.blobsAppsAccounts, {
  payload: AppsAccountsInput,
  success: AppsAccountsResult,
  error: BlobsRpcError,
});
const BlobsAppsConnectRpc = Rpc.make(RPC_METHODS.blobsAppsConnect, {
  payload: AppsConnectInput,
  success: AppsConnectResult,
  error: BlobsRpcError,
});
const BlobsAppsDisconnectRpc = Rpc.make(RPC_METHODS.blobsAppsDisconnect, {
  payload: AppsDisconnectInput,
  success: AppsDisconnectResult,
  error: BlobsRpcError,
});
const BlobsAppsToolsRpc = Rpc.make(RPC_METHODS.blobsAppsTools, {
  payload: AppsToolsInput,
  success: AppsToolsResult,
  error: BlobsRpcError,
});
const BlobsAppsDecisionsRpc = Rpc.make(RPC_METHODS.blobsAppsDecisions, {
  payload: AppsDecisionsInput,
  success: AppsDecisionsResult,
  error: BlobsRpcError,
});

const EnginesListRpc = Rpc.make(RPC_METHODS.enginesList, {
  payload: EnginesListInput,
  success: EnginesView,
  error: BlobsRpcError,
});
const EnginesDoRpc = Rpc.make(RPC_METHODS.enginesDo, {
  payload: EnginesDoInput,
  success: EnginesDoResult,
  error: BlobsRpcError,
});

const TrustRpcError = Schema.Union([TrustOperationError, HostAuthorizationError]);
const ExtRpcError = Schema.Union([Ext.ExtensionOperationError, HostAuthorizationError]);
const extRpc = <P extends Schema.Top, S extends Schema.Top>(tag: string, payload: P, success: S) =>
  Rpc.make(tag, { payload, success, error: ExtRpcError });
const ExtensionsRpcs = [
  extRpc(RPC_METHODS.extensionsList, Schema.Struct({}), Ext.ExtensionsListResult),
  extRpc(RPC_METHODS.extensionsSave, Ext.ExtensionSaveInput, Ext.ExtensionServer),
  extRpc(RPC_METHODS.extensionsRemove, Ext.ExtensionNameInput, Ext.ExtensionOkResult),
  extRpc(RPC_METHODS.extensionsSetEnabled, Ext.ExtensionEnabledInput, Ext.ExtensionServer),
  extRpc(RPC_METHODS.extensionsTest, Ext.ExtensionTestInput, Ext.ExtensionTestResult),
  extRpc(RPC_METHODS.extensionsParse, Ext.ExtensionParseInput, Ext.ExtensionParseResult),
  extRpc(RPC_METHODS.extensionsDiscover, Schema.Struct({}), Ext.ExtensionDiscoverResult),
  extRpc(RPC_METHODS.extensionsCatalog, Schema.Struct({}), Ext.ExtensionCatalogResult),
  extRpc(RPC_METHODS.extensionsAddFromCatalog, Ext.ExtensionCatalogAddInput, Ext.ExtensionServer),
  extRpc(RPC_METHODS.extensionsProject, Ext.ExtensionProjectInput, Ext.ExtensionProjectResult),
  extRpc(
    RPC_METHODS.extensionsProjectApprove,
    Ext.ExtensionProjectApproveInput,
    Ext.ExtensionOkResult,
  ),
  extRpc(RPC_METHODS.extensionsSkillAdd, Ext.ExtensionSkillAddInput, Ext.ExtensionSkillAddResult),
  extRpc(RPC_METHODS.extensionsSkillRemove, Ext.ExtensionNameInput, Ext.ExtensionOkResult),
  extRpc(RPC_METHODS.extensionsSkillSetEnabled, Ext.ExtensionEnabledInput, Ext.ExtensionSkill),
  extRpc(
    RPC_METHODS.extensionsSetProjectSecret,
    Ext.ExtensionProjectSecretInput,
    Ext.ExtensionOkResult,
  ),
] as const;
const BlobsGroupsSubscribeRpc = Rpc.make(RPC_METHODS.blobsGroupsSubscribe, {
  payload: GroupsSubscribeInput,
  success: GroupsStreamEvent,
  error: BlobsRpcError,
  stream: true,
});
const BlobsGroupsCreateRpc = Rpc.make(RPC_METHODS.blobsGroupsCreate, {
  payload: GroupCreateInput,
  success: GroupWire,
  error: BlobsRpcError,
});
const BlobsGroupsUpdateRpc = Rpc.make(RPC_METHODS.blobsGroupsUpdate, {
  payload: GroupUpdateInput,
  success: GroupWire,
  error: BlobsRpcError,
});
const BlobsGroupsArchiveRpc = Rpc.make(RPC_METHODS.blobsGroupsArchive, {
  payload: GroupIdInput,
  success: GroupWire,
  error: BlobsRpcError,
});
const BlobsGroupsDeleteRpc = Rpc.make(RPC_METHODS.blobsGroupsDelete, {
  payload: GroupDeleteInput,
  success: BlobEmptyResult,
  error: BlobsRpcError,
});
const BlobsTeamOptionsRpc = Rpc.make(RPC_METHODS.blobsTeamOptions, {
  payload: TeamOptionsInput,
  success: TeamOptionsResult,
  error: BlobsRpcError,
});
const BlobsTeamPreviewRpc = Rpc.make(RPC_METHODS.blobsTeamPreview, {
  payload: TeamPreviewInput,
  success: TeamExportReport,
  error: BlobsRpcError,
});
const BlobsTeamExportRpc = Rpc.make(RPC_METHODS.blobsTeamExport, {
  payload: TeamExportInput,
  success: TeamExportResult,
  error: BlobsRpcError,
});
const BlobsTeamImportPlanRpc = Rpc.make(RPC_METHODS.blobsTeamImportPlan, {
  payload: TeamImportPlanInput,
  success: TeamImportPlan,
  error: BlobsRpcError,
});
const BlobsTeamImportApplyRpc = Rpc.make(RPC_METHODS.blobsTeamImportApply, {
  payload: TeamImportApplyInput,
  success: TeamImportResult,
  error: BlobsRpcError,
});
const BlobsOutsideSetupRpc = Rpc.make(RPC_METHODS.blobsOutsideSetup, {
  payload: OutsideSetupInput,
  success: OutsideSetupResult,
  error: BlobsRpcError,
});
const BlobsOutsideTokensRpc = Rpc.make(RPC_METHODS.blobsOutsideTokens, {
  payload: OutsideSetupInput,
  success: OutsideTokensResult,
  error: BlobsRpcError,
});
const BlobsOutsideCreateRpc = Rpc.make(RPC_METHODS.blobsOutsideCreate, {
  payload: OutsideCreateInput,
  success: OutsideCreateResult,
  error: BlobsRpcError,
});
const BlobsOutsideRevokeRpc = Rpc.make(RPC_METHODS.blobsOutsideRevoke, {
  payload: OutsideRevokeInput,
  success: OutsideRevokeResult,
  error: BlobsRpcError,
});
const BlobsOutsideAuditRpc = Rpc.make(RPC_METHODS.blobsOutsideAudit, {
  payload: OutsideAuditInput,
  success: OutsideAuditResult,
  error: BlobsRpcError,
});

const TrustGetRpc = Rpc.make(RPC_METHODS.trustGet, {
  payload: TrustGetInput,
  success: FolderTrustStatus,
  error: TrustRpcError,
});
const TrustSetRpc = Rpc.make(RPC_METHODS.trustSet, {
  payload: TrustSetInput,
  success: FolderTrustStatus,
  error: TrustRpcError,
});
const TrustListRpc = Rpc.make(RPC_METHODS.trustList, {
  payload: Schema.Struct({}),
  success: TrustListResult,
  error: TrustRpcError,
});

export const SubscribeDaemonConfigRpc = Rpc.make(RPC_METHODS.subscribeDaemonConfig, {
  payload: Schema.Struct({
    /**
     * Whether this client understands `hostThemesUpdated` events.
     * Already-shipped clients decode the stream against the old event union
     * and would die on an unknown member, so the server emits the theme
     * stream only to subscribers that ask for it. Absent on old clients;
     * dropped by old servers.
     */
    hostThemes: Schema.optional(Schema.Boolean),
    /** Whether this client understands `usageLimitSourcesUpdated` events. */
    usageLimitSources: Schema.optional(Schema.Boolean),
    /**
     * Whether this client answers `/usage-limits` itself. The server injects
     * that command into provider catalogs only for such clients; an older
     * client would send it to the provider as an ordinary prompt.
     */
    usageLimitsCommand: Schema.optional(Schema.Boolean),
  }),
  success: DaemonConfigStreamEvent,
  error: Schema.Union([DaemonPrefsError, HostAuthorizationError]),
  stream: true,
});

const SubscribeDaemonLifecycleRpc = Rpc.make(RPC_METHODS.subscribeDaemonLifecycle, {
  payload: Schema.Struct({}),
  success: DaemonLifecycleStreamEvent,
  error: HostAuthorizationError,
  stream: true,
});

export const KoraRpcGroup = RpcGroup.make(
  DaemonProbeRpc,
  DaemonGetConfigRpc,
  DaemonUpdatePrefsRpc,
  ProjectsListEntriesRpc,
  ProjectsReadFileRpc,
  ProjectsSearchContentsRpc,
  ProjectsSearchEntriesRpc,
  ProjectsWriteFileRpc,
  ShellOpenInEditorRpc,
  FilesystemBrowseRpc,
  TerminalOpenRpc,
  TerminalAttachRpc,
  TerminalWriteRpc,
  TerminalResizeRpc,
  TerminalCloseRpc,
  SubscribeTerminalMetadataRpc,
  FleetSubscribeRpc,
  FleetSteerRpc,
  FleetKillRpc,
  FleetRetryRpc,
  FleetExtendRpc,
  FleetMergeVerifyRpc,
  FleetMergeRpc,
  FleetReadReportRpc,
  FleetSubscribeWorkerRpc,
  FleetRespondApprovalRpc,
  SwarmSubscribeRpc,
  SwarmGetStatusRpc,
  SwarmInstallStartRpc,
  SwarmInstallCancelRpc,
  SwarmSetKeyRpc,
  SwarmClearKeyRpc,
  SwarmTestProviderRpc,
  SwarmSetConsentRpc,
  SwarmSetPreferencesRpc,
  BlobsSubscribeRpc,
  BlobsListRpc,
  BlobsGetRpc,
  BlobsCreateRpc,
  BlobsUpdateRpc,
  BlobsSetSoulRpc,
  BlobsArchiveRpc,
  BlobsRehireRpc,
  BlobsDeleteRpc,
  BlobsDuplicateRpc,
  BlobsGetAboutMeRpc,
  BlobsSetAboutMeRpc,
  BlobsGetDefaultsRpc,
  BlobsSetDefaultsRpc,
  BlobsSetFlagRpc,
  BlobsUsageRpc,
  BlobsFilesRpc,
  BlobsMemoryListRpc,
  BlobsMemoryEditRpc,
  BlobsMemoryForgetRpc,
  BlobsMemoryImportantRpc,
  BlobsMemoryUndoRpc,
  BlobsMemoryConfirmRpc,
  BlobsMemorySetCoreRpc,
  BlobsMemorySearchRpc,
  BlobsTemplatesRpc,
  BlobsHireTemplatesRpc,
  BlobsJobGetRpc,
  BlobsJobCancelRpc,
  BlobsJobFeedbackRpc,
  BlobsProposalDismissRpc,
  BlobsConfirmResolveRpc,
  BlobsContinueOnFreeRpc,
  BlobsUndoSelfChangeRpc,
  BlobsRoutinesSnapshotRpc,
  BlobsRoutinesSubscribeRpc,
  BlobsRoutinesThreadsRpc,
  BlobsRoutinesPreviewRpc,
  BlobsRoutinesSaveRpc,
  BlobsRoutinesSetPausedRpc,
  BlobsRoutinesRemoveRpc,
  BlobsRoutinesRunNowRpc,
  BlobsRoutinesCancelRunRpc,
  BlobsRoutinesCreateTriggerRpc,
  BlobsRoutinesRotateTriggerRpc,
  BlobsRoutinesDeleteTriggerRpc,
  BlobsRoutinesConfirmRpc,
  BlobsAppsStatusRpc,
  BlobsAppsSetKeyRpc,
  BlobsAppsClearKeyRpc,
  BlobsAppsResetBrokerRpc,
  BlobsAppsToolkitsRpc,
  BlobsAppsAccountsRpc,
  BlobsAppsConnectRpc,
  BlobsAppsDisconnectRpc,
  BlobsAppsToolsRpc,
  BlobsAppsDecisionsRpc,
  EnginesListRpc,
  EnginesDoRpc,
  BlobsGroupsSubscribeRpc,
  BlobsGroupsCreateRpc,
  BlobsGroupsUpdateRpc,
  BlobsGroupsArchiveRpc,
  BlobsGroupsDeleteRpc,
  BlobsTeamOptionsRpc,
  BlobsTeamPreviewRpc,
  BlobsTeamExportRpc,
  BlobsTeamImportPlanRpc,
  BlobsTeamImportApplyRpc,
  BlobsOutsideSetupRpc,
  BlobsOutsideTokensRpc,
  BlobsOutsideCreateRpc,
  BlobsOutsideRevokeRpc,
  BlobsOutsideAuditRpc,
  TrustGetRpc,
  TrustSetRpc,
  TrustListRpc,
  ...ExtensionsRpcs,
  WebOpenRpc,
  WebResizeRpc,
  WebCloseRpc,
  WebListRpc,
  WebReportStatusRpc,
  SubscribeWebEventsRpc,
  SubscribeDaemonConfigRpc,
  SubscribeDaemonLifecycleRpc,
  ChatDispatchRpc,
  ChatListArchivedThreadsRpc,
  ChatSubscribeThreadsRpc,
  ChatSubscribeThreadRpc,
);
