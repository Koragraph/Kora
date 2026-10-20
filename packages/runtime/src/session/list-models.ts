// List the Claude model catalog straight from the Claude Agent SDK (the same catalog `/model` shows in the
// CLI), so the desktop model picker reflects the latest models this Claude Code version offers instead of a
// hardcoded list. `query(...).supportedModels()` opens the SDK control channel (which starts the `claude`
// worker), returns the catalog, and we tear the session down immediately without ever sending a turn.
//
// Best-effort and bounded: any failure (SDK missing, not authenticated, worker slow) resolves to null within
// the timeout so callers fall back to their static list and boot is never blocked.

/** Options for an idle control-channel probe: load none of the user's Claude settings (their SessionStart hooks) or MCP servers on every daemon boot (deep A3-8). */
export function idleProbeOptions(ac: AbortController, permissionMode: 'default' | 'bypassPermissions'): Record<string, unknown> {
  return { abortController: ac, permissionMode, settingSources: [], strictMcpConfig: true };
}

/** One row of the Claude model catalog. Mirrors the SDK's `ModelInfo`, kept local so callers don't need the SDK types. */
export interface ClaudeModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
}

/**
 * Return the Claude model catalog, or null if it can't be obtained within `timeoutMs`.
 * Never throws.
 */
export async function listClaudeModels(timeoutMs = 6000): Promise<ClaudeModelInfo[] | null> {
  let sdk: any;
  try {
    sdk = require('@anthropic-ai/claude-agent-sdk');
  } catch {
    return null;
  }
  const query = sdk?.query;
  if (typeof query !== 'function') return null;

  const ac = new AbortController();
  // A prompt generator that never yields: we only want the control channel, not a turn.
  async function* idlePrompt(): AsyncGenerator<never> {
    await new Promise<void>((resolve) => {
      if (ac.signal.aborted) return resolve();
      ac.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  let q: any;
  try {
    q = query({ prompt: idlePrompt(), options: idleProbeOptions(ac, 'bypassPermissions') });
  } catch {
    return null;
  }

  const cleanup = () => {
    // Aborting the controller closes the SDK transport and terminates the `claude` worker; that is the whole
    // teardown. Do NOT also call interrupt() — post-abort it rejects with "Operation aborted", and unawaited
    // that surfaces as an unhandled rejection. Swallow the return()'s promise for the same reason.
    try { ac.abort(); } catch { /* best effort */ }
    try {
      const r = q?.return?.(undefined);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* best effort */ }
  };

  try {
    const models = await Promise.race([
      q.supportedModels() as Promise<ClaudeModelInfo[]>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!Array.isArray(models) || models.length === 0) return null;
    return models;
  } catch {
    return null;
  } finally {
    cleanup();
  }
}
