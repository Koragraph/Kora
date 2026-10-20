// Side sessions (overnight B15): a one-shot model call that must not touch the user's thread. Used where a small piece of
// text is wanted from a model (the "fresh thread" brief; later a title or a commit message): the SDK, no tools, none of the
// user's settings/hooks/MCP, a two-line system prompt, Haiku at low effort, one turn, nothing saved to disk. A main-thread
// turn for the same text would re-send the thread's whole context (100k+ tokens); this sends only what it is given.
// Fail-open: any problem (SDK missing, signed out, timeout) resolves to null and the caller falls back to something local.
import { engineSpawnEnv } from '../detect/engine-binary';
import { claudePrivacyEnv } from '../util/claude-privacy';
import { sessionBaseEnv } from './drivers/claude-driver';

export const SIDE_MODEL = 'claude-haiku-5-5';
export const SIDE_TIMEOUT_MS = 45_000;

export type SideQueryFn = (params: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<any>;

export interface SideQuery {
  /** The whole instruction, two lines at most. */
  system: string;
  /** Everything the model needs: it sees nothing else. */
  prompt: string;
  /** a CLAUDE_CONFIG_DIR etc. so the call bills the same login as the thread */
  accountEnv?: Record<string, string>;
  cwd?: string;
  model?: string;
  timeoutMs?: number;
  /** tests */
  queryFn?: SideQueryFn;
}

/** The SDK options for a side session. Exported so a test can pin them: tools off, no settings, no MCP, nothing persisted. */
export function sideSessionOptions(q: SideQuery, abort: AbortController): Record<string, unknown> {
  return {
    abortController: abort,
    cwd: q.cwd ?? require('node:os').tmpdir(),
    model: q.model ?? SIDE_MODEL,
    systemPrompt: q.system,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    maxTurns: 1,
    // Asked not to think (with MAX_THINKING_TOKENS=0 in env). Measured live: Haiku 5.5 still reasoned 300-700 tokens on a real brief,
    // so a brief costs ~1.4k tokens in total (~$0.02) - against re-sending a 100k+ thread.
    thinking: { type: 'disabled' },
    persistSession: false,
    permissionMode: 'default',
    env: engineSpawnEnv({ ...sessionBaseEnv(), ...claudePrivacyEnv(), ...(q.accountEnv ?? {}), MAX_THINKING_TOKENS: '0' }),
  };
}

/** The reply text, or null. Never throws. */
export async function sideQuery(q: SideQuery): Promise<string | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), q.timeoutMs ?? SIDE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const queryFn: SideQueryFn | undefined = q.queryFn ?? ((): SideQueryFn | undefined => { try { return require('@anthropic-ai/claude-agent-sdk').query; } catch { return undefined; } })();
    if (!queryFn) return null;
    let text = '';
    for await (const m of queryFn({ prompt: q.prompt, options: sideSessionOptions(q, abort) })) {
      if (m?.type === 'assistant' && Array.isArray(m.message?.content)) {
        // one message per content block: the last text block of the last message is the reply
        const t = m.message.content.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('');
        if (t) text = t;
      } else if (m?.type === 'result') {
        if (m.is_error) return null;
        if (typeof m.result === 'string' && m.result.trim()) text = m.result;
        break;
      }
    }
    const out = text.trim();
    return out ? out : null;
  } catch { return null; }
  finally { clearTimeout(timer); try { abort.abort(); } catch { /* done */ } }
}
