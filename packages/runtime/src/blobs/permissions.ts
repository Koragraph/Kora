// Profile permission ("ask" | "auto" | "full") -> the RuntimeMode each engine understands (docs/bots/ARCH.md 2.2).
//
//   engine    ask                  auto (default)                                   full
//   claude    approval-required    auto (SDK auto mode) + blob policy               full-access
//   codex     approval-required    auto-accept-edits = workspace-write sandbox      full-access
//             (read-only sandbox)  + network access (web research needs it)
//   opencode  approval-required    auto-accept-edits = edit/read inside cwd,        full-access (--auto)
//             (read-only perm)     external_directory + destructive bash denied
//
// Codex and OpenCode cannot pause for an approval mid-turn, so "always ask before sending/posting/paying" is, on
// those engines, the persona rule + Kora's own tool handlers - not a sandbox (ruling 4).
import type { RuntimeMode } from '../session/events';
import type { BlobPermission } from './types';

export function resolveBlobRuntimeMode(instanceId: string, permission: BlobPermission): RuntimeMode {
  if (permission === 'full') return 'full-access';
  if (permission === 'ask') return 'approval-required';
  return agentOfInstance(instanceId) === 'claude' ? 'auto' : 'auto-accept-edits';
}

/** `claude-work` is the Claude driver on the named account `work` (an instance id is a slug: no colon, the wire schema refuses one). */
export function claudeAccountOfInstance(instanceId: string): string | null {
  const m = /^claude-([a-z0-9][a-z0-9-]{0,29})$/.exec(instanceId);
  return m ? (m[1] ?? null) : null;
}

/**
 * The agent (driver) id behind a provider instance id (`claude`, `claude-work`, `codex:work`, `opencode`). Phase 7 engines
 * pass through whole (`gemini`, `acp-hermes`, `api-groq`): each is its own driver.
 */
export function agentOfInstance(instanceId: string): string {
  if (claudeAccountOfInstance(instanceId)) return 'claude';
  const a = instanceId.split(':')[0] ?? '';
  if (a === 'codex' || a === 'opencode') return a;
  // the Phase 7 engines are their own drivers; anything else unknown is Claude, as it always was
  return /^(gemini|grok|cursor|kimi|qwen|droid|acp-[a-z0-9-]+|api-[a-z0-9-]+)$/.test(a) ? a : 'claude';
}

/** The honest one-line help for the editor's Permissions tab. */
export function permissionHelp(instanceId: string): string {
  const a = agentOfInstance(instanceId);
  if (a.startsWith('acp-') || a === 'gemini' || a.startsWith('api-')) {
    return 'Kora enforces this itself on this engine: Ask asks before editing or running anything, Auto is free inside the blob\'s folders and asks outside them and before anything that sends, posts or pays, Full never asks. It is a policy check, not a sandbox.';
  }
  const tail = 'Sending, posting, paying and signing in always asks first on Claude; on Codex and free models that rule is part of the blob\'s instructions and Kora\'s own tools, not a sandbox.';
  return a === 'claude' ? 'Auto: works freely in its own folder, asks before anything outside it or anything that sends or deletes. ' + tail : 'Auto: works in its own folder with the sandbox your engine provides. ' + tail;
}
