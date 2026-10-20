// How a Codex / OpenCode blob session reaches its tools: the `kora_blobs` MCP server (`kora mcp --blobs`). Identity and
// the per-session bearer token ride on argv, never env: Codex starts MCP servers with a scrubbed environment (the same
// reason `kora mcp --fleet` takes its identity on argv). The daemon revokes the token when the turn/thread ends.
export const BLOBS_MCP_NAME = 'kora_blobs';

export interface BlobsMcpSpec { command: string; args: string[] }

export function blobsMcpSpec(i: { binPath: string; socketPath: string; blobId: string; token: string; threadId: string; agent: string; execPath?: string }): BlobsMcpSpec {
  return {
    command: i.execPath ?? process.execPath,
    args: [i.binPath, 'mcp', '--blobs', '--blob', i.blobId, '--token', i.token, '--socket', i.socketPath, '--thread', i.threadId, '--agent', i.agent],
  };
}

/** Codex: `-c mcp_servers.kora_blobs.command=... -c mcp_servers.kora_blobs.args=[...]`. */
export function codexBlobsMcpArgs(spec: BlobsMcpSpec): string[] {
  // tool_timeout_sec: wait_for / delegation tools legitimately take minutes (Codex's default is 60 s).
  return ['-c', `mcp_servers.${BLOBS_MCP_NAME}.command=${JSON.stringify(spec.command)}`, '-c', `mcp_servers.${BLOBS_MCP_NAME}.args=${JSON.stringify(spec.args)}`, '-c', `mcp_servers.${BLOBS_MCP_NAME}.tool_timeout_sec=600`];
}

/** OpenCode: the `mcp` entry merged into the per-run OPENCODE_CONFIG_CONTENT. */
export function opencodeBlobsMcpEntry(spec: BlobsMcpSpec): { [BLOBS_MCP_NAME]: { type: 'local'; command: string[]; enabled: true } } {
  return { [BLOBS_MCP_NAME]: { type: 'local', command: [spec.command, ...spec.args], enabled: true } };
}

/** Merge the kora_blobs entry into an existing OPENCODE_CONFIG_CONTENT string (or start a new one). */
export function withOpencodeBlobsMcp(configContent: string | undefined, spec: BlobsMcpSpec): string {
  let cfg: Record<string, any> = {};
  try { const p = configContent ? JSON.parse(configContent) : {}; if (p && typeof p === 'object') cfg = p; } catch { cfg = {}; }
  cfg.mcp = { ...(cfg.mcp && typeof cfg.mcp === 'object' ? cfg.mcp : {}), ...opencodeBlobsMcpEntry(spec) };
  return JSON.stringify(cfg);
}
