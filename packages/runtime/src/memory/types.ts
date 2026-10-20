// Shared types and tunables for the Blobs memory engine. See index.ts for the public API.

export type Scope = 'you' | 'blob' | 'team';

/** Injected LLM call. The engine never picks a model; it only sends small strict-JSON prompts. */
export type Extractor = (req: { system: string; prompt: string; maxTokens: number }) => Promise<string>;

/** Optional on-device embedder. Vectors are compared with cosine, so they should be L2-normalised. */
export interface Embedder {
  /** Stable id of model+version. Stored with each vector; a changed id means "re-embed". */
  readonly id: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface Fact {
  id: string;
  scope: Scope;
  /** Set for scope 'blob' only. */
  blobId?: string;
  text: string;
  /** Epoch ms from which the fact is believed true. */
  since: number;
  /** Epoch ms at which it stopped being true (retired). */
  until?: number;
  confidence: number;
  important: boolean;
  createdAt: number;
  lastUsedAt: number;
  useCount: number;
  source: { threadId: string | null; messageId: string | null };
  retiredReason?: string;
  supersededBy?: string;
}

export type ReceiptKind = 'added' | 'updated' | 'retired' | 'pending';

export interface Receipt {
  id: string;
  kind: ReceiptKind;
  /** Fact the change is about ('' for a pending item that has no fact yet). */
  factId: string;
  /** Set for kind 'pending': approve with approvePending(pendingId) / reject with rejectPending. */
  pendingId?: string;
  text: string;
  /** For kind 'updated': the text it replaced (returned by the call that made it; not persisted). */
  previousText?: string;
  blobId: string;
  createdAt: number;
}

export interface PendingItem {
  id: string;
  kind: 'add' | 'update';
  scope: Scope;
  blobId: string | null;
  text: string;
  targetFactId?: string;
  reason: 'sensitive' | 'low_confidence';
  confidence: number;
  createdAt: number;
  source: { threadId: string | null; messageId: string | null };
}

export interface Question {
  id: string;
  blobId: string | null;
  scope: Scope;
  /** Ready-made neutral wording; the blob rephrases it naturally. */
  text: string;
  factIds: string[];
  /** The newer claim, applied if the user confirms it (resolveQuestion(id, 'new')). */
  proposed?: string;
  createdAt: number;
}

export interface EpisodeHit {
  kind: 'summary' | 'turn';
  threadId: string;
  blobId: string;
  text: string;
  snippet: string;
  at: number;
  score: number;
}

export interface TurnInput {
  blobId: string;
  threadId: string;
  /** Provenance id of the exchange (back-compat). Prefer userMessageId/assistantMessageId. */
  messageId?: string;
  /** The user message the facts come from (stored as the fact's source message). */
  userMessageId?: string;
  assistantMessageId?: string;
  userText: string;
  assistantText: string;
  at: number;
  /** Let this turn write scope 'team' facts (Chief only). Default false. */
  allowTeam?: boolean;
  /** false = index the turn for search but learn nothing from it (a Kora hand-off brief is Kora's words, not the user's). */
  learn?: boolean;
}

/** A TurnInput with its provenance id resolved (userMessageId ?? messageId ?? ''). */
export type NormTurn = TurnInput & { messageId: string };

export const LIMITS = {
  /** Hard core-note caps in estimated tokens (≈1.5k together). */
  coreYouTokens: 700,
  coreBlobTokens: 800,
  coreTeamTokens: 800,
  factMaxChars: 300,
  maxOpsPerTurn: 6,
  /** Items below this confidence wait for the user's OK. */
  minConfidence: 0.6,
  /** Non-important facts unused this long leave recall (still searchable). */
  decayDays: 90,
  /** Tidy retires never-used trivia after this long. */
  staleDays: 365,
  recallMaxFacts: 12,
  turnTextMaxChars: 2000,
  burstFacts: 20,
} as const;

export const DAY_MS = 86_400_000;
