// Blobs runtime types (docs/bots/ARCH.md section 3). The runtime never imports @kora/contracts: these interfaces are
// the structural twins of packages/contracts/src/blobs.ts, and the ui-server adapts through `KoraBlobsLike` (host.ts).
import type { FleetToolSpec } from '../session/fleet-tools';

export const CHIEF_BLOB_ID = 'blob_kora';

export type BlobRole = 'chief' | 'member';
export type BlobPermission = 'ask' | 'auto' | 'full';
export interface BlobEngine { instanceId: string; model: string; effort: string | null }
export interface BlobOutfitWire { head: string | null; face: string | null; neck: string | null }
export interface BlobToolGrants {
  apps: { mode: 'none' | 'all' | 'list'; allow: string[] };
  mcp: string[];
  computer: { browser: boolean; vm: boolean; /** Phase 6: let this blob's browser save downloads into <workspace>/downloads. */ allowDownloads?: boolean; /** Phase 6: local dev servers its browser may open (`localhost`, `127.0.0.1:5173`, `*.test`). */ allowLocalHosts?: string[] };
  /** "Always for this blob" approvals (approval-rules.ts); absent on older profiles. */
  approvals?: Array<{ id: string; kind: 'command' | 'path' | 'app'; match: string; label: string; at: number }>;
}

export interface BlobProfile {
  id: string;
  version: 1;
  name: string;
  title: string;
  role: BlobRole;
  teamId: string;
  engine: BlobEngine;
  permission: BlobPermission;
  outfit: BlobOutfitWire | null;
  toolGrants: BlobToolGrants;
  slug: string;
  /** Absolute path of the Finder folder. */
  workspace: string;
  templateId: string | null;
  /** Which version of the starter template this blob's SOUL was last brought up to (absent = hired before versions). */
  templateVersion?: number;
  /** Free helpers (kora_spawn / kora_map on free OpenCode models) for the blob's legwork. Absent = on. */
  helpers?: boolean;
  pinned: boolean;
  hidden: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type BlobProfilePatch = Partial<Pick<BlobProfile, 'name' | 'title' | 'teamId' | 'engine' | 'permission' | 'outfit' | 'toolGrants' | 'templateId' | 'pinned' | 'hidden' | 'helpers'>>;

/** What `BlobStore.create` needs (a BlobDraft minus the card-only fields). */
export interface BlobCreateInput {
  name: string;
  title: string;
  soul: string;
  engine: BlobEngine;
  permission?: BlobPermission;
  outfit?: BlobOutfitWire | null;
  toolGrants?: BlobToolGrants;
  templateId?: string | null;
  templateVersion?: number;
  role?: BlobRole;
  /** Fixed id (the Chief). */
  id?: string;
  pinned?: boolean;
}

export interface BlobDefaults { engine: BlobEngine | null; permission: BlobPermission; soulTemplate: string }
export interface BlobFlags { concurrencyWarningDismissed: boolean; galleryDismissed: boolean; claudeMemoryFallback: boolean }

export interface TokenTotals { input: number; cached: number; output: number; turns: number }

export interface ThreadOrigin {
  kind: 'user' | 'kora' | 'routine' | 'continue';
  jobId: string | null;
  stepId: string | null;
  fromThreadId: string | null;
  fromBlobId: string | null;
  /** Routine runs only: which routine and which run this hidden execution thread belongs to. */
  routineId?: string | null;
  runId?: string | null;
}

export interface MemoryReceiptWire {
  id: string;
  kind: 'added' | 'updated' | 'retired' | 'held';
  scope: 'you' | 'blob' | 'team';
  text: string;
  previousText: string | null;
  factId: string | null;
  undone: boolean;
  reason: string | null;
}

export interface BlobFactWire {
  id: string;
  scope: 'you' | 'blob' | 'team';
  blobId: string | null;
  text: string;
  since: number;
  until: number | null;
  confidence: number;
  important: boolean;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  lastUsedAt: number | null;
}

/** A blob.card payload: validated by the ui-server against the contract; the runtime only builds the ones it owns. */
export type BlobCard = { cardKind: string; cardId: string; version: number; [k: string]: unknown };

export interface BlobToolContext {
  blobId: string;
  threadId: string;
  agent: string;
  cwd: string;
  /** Show a card in this thread's transcript (activity `blob.card`). */
  emitCard?(card: BlobCard): void;
  /** Show a finished file as an output card (absolute path, already inside the blob's workspace). */
  attachOutput?(path: string, caption: string | null): void;
  /**
   * Park a yes/no question for the user on this thread (an approval card) and resolve with their answer. Used by connected
   * app actions that send / post / delete / pay: the tool handler awaits it, so it is real enforcement on every engine.
   * Absent = no way to ask right now (the caller fails closed). Never resolves true by itself.
   */
  askApproval?(p: { title: string; detail: string; args: unknown; always?: { label: string; remember(): void }; /** Aborts when the question was answered elsewhere (the browser panel's bar): the card retires itself. */ signal?: AbortSignal }): Promise<boolean>;
}

/** `fast`: a latency-bound caller (group routing) - runs now, beside whatever the single-file queue is doing. */
export type OneShot = (prompt: string, o?: { budgetMs?: number; json?: boolean; fast?: boolean }) => Promise<{ text: string; model: string } | null>;

export type { FleetToolSpec };
