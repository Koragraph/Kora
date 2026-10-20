// Connected apps (Phase 5). See docs/bots/APPS.md and ./WIRING.md.
import path from 'node:path';
import { blobsStoreDir } from '../home';
import { defaultSecretStore } from './secrets';
import { AppsService } from './service';

export * from './types';
export * from './grants';
export { classifyTool } from './classify';
export { DecisionLog, type DecisionRow } from './decision-log';
export { defaultSecretStore, FileSecretStore, KeychainSecretStore, MemorySecretStore, WindowsCredentialSecretStore, type SecretStore } from './secrets';
export { AppsService, BYO_KEY_SECRET, type AppRunResult, type AppsCaller, type ApprovalRequest, type Approver } from './service';
export { APPROVAL_TIMEOUT_MS, ParkedApprovals, askVia, approvalCopy, argsSummary, toolkitLabel, type ParkedEmit } from './approval';
export { appToolSpecs, type AppToolContext } from './tools';
export { BrokerBackend } from './broker-backend';
export { ByoBackend } from './byo-backend';

/** Baked into release builds (scripts/build.sh sets it); KORA_COMPOSIO_BROKER_URL overrides for dev. */
export const DEFAULT_BROKER_URL: string | undefined = undefined;

export function appsDir(): string { return path.join(blobsStoreDir(), 'apps'); }

export function createAppsService(o: { brokerUrl?: string } = {}): AppsService {
  const dir = appsDir();
  const byo = process.env.KORA_COMPOSIO_API_BASE?.trim();
  return new AppsService({ dir, secrets: defaultSecretStore(path.join(dir, 'secrets')), brokerUrl: o.brokerUrl ?? (process.env.KORA_COMPOSIO_BROKER_URL?.trim() || DEFAULT_BROKER_URL), ...(byo ? { byoBaseUrl: byo } : {}) });
}
