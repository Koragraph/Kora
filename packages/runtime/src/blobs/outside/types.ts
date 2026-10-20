// Outside access (Phase 8): the shapes shared by the token store, the audit log, the tool handlers and the host the
// daemon injects. Nothing here imports the chat engine - `OutsideHost` is the whole seam (docs/bots/OUTSIDE.md).

/** What an outside client may see of a blob. */
export interface OutsideBlob {
  id: string;
  name: string;
  title: string;
  role: 'chief' | 'member';
  /** idle | working | needs-you | error */
  status: string;
  engine: { instanceId: string; model: string };
}

export type ThreadStatus = 'running' | 'settled' | 'needs-you' | 'error';

export interface OutsideThreadHead { id: string; blobId: string; title: string; status: ThreadStatus; updatedAt: number; messageCount: number }

export interface OutsideOutput { path: string; name: string; bytes: number | null; at: number | null; threadId: string | null; caption?: string | null }

/** One transcript row, already normalised by the host. `tool` rows carry a one-line summary, never raw arguments/output. */
export interface OutsideRow {
  role: 'user' | 'assistant' | 'tool' | 'note';
  text: string;
  at: number | null;
  /** tool rows: the tool name + a one-line summary ("Read notes.md", "Searched the web for ..."). */
  tool?: { name: string; summary: string };
  outputs?: OutsideOutput[];
  /** user rows sent through this feature: the client name. */
  via?: string;
  /** an unanswered approval sits on this row ("needs you in Kora"). */
  needsYou?: string;
}

export interface OutsideModelChoice { instanceId: string; model: string; label: string }

export interface OutsideSearchHit { kind: 'thread' | 'blob' | 'output'; id: string; blobId: string | null; title: string; snippet: string }

export interface SendResult { threadId: string; blobId: string; refused?: undefined }
export type SendRefusal = { refused: 'busy' | 'archived' | 'unknown' | 'empty'; message?: string };

export interface OutsideGroup { id: string; name: string; members: string[] }

/** The daemon-side facade. Every method is read-only or a plain "send a message"; there is deliberately nothing here
 *  that can answer an approval, delete, change settings, touch secrets/memory/app grants/computer or routines. */
export interface OutsideHost {
  chiefId(): string | null;
  listBlobs(): OutsideBlob[];
  /** profile summary + capability card + skill names (never the SOUL text, memory or keys). */
  describeBlob(blobId: string): { summary: string; card: string | null; skills: string[]; workspaceName: string } | null;
  listThreads(blobId: string): OutsideThreadHead[];
  getThread(threadId: string): OutsideThreadHead | null;
  threadRows(threadId: string): OutsideRow[];
  search(query: string, limit: number): OutsideSearchHit[];
  sendMessage(i: { blobId?: string; threadId?: string; text: string; via: { client: string; tokenId: string } }): Promise<SendResult | SendRefusal>;
  allowedModels(blobId: string): OutsideModelChoice[];
  setModel(blobId: string, choice: OutsideModelChoice): Promise<boolean>;
  interrupt(threadId: string): Promise<boolean>;
  listOutputs(blobId: string, limit: number): OutsideOutput[];
  /** Feature-detected: present only once groups exist. */
  groups?: {
    list(): OutsideGroup[];
    send(i: { groupId: string; text: string; via: { client: string; tokenId: string } }): Promise<{ ok: boolean; message?: string }>;
  };
}

export interface TokenRecord { id: string; name: string; createdAt: number; lastUsedAt: number | null; revokedAt: number | null; suffix: string }

export interface AuditRow { id: string; at: number; tokenId: string; client: string; tool: string; target: string | null; ok: boolean; note: string | null }

export interface ToolParam { type: 'string' | 'number' | 'boolean'; description?: string; optional?: boolean; enum?: readonly string[] }
export type ToolParams = Record<string, ToolParam>;

export interface OutsideToolResult { text: string; isError?: boolean }
