export { detect, loadManifests, manifestFor, parseManifest, regionText, convertRegex, splitLines, blockerText } from './manifest';
export type { Detection, DetectionSnapshot, Manifest, Rule } from './manifest';
export { StateTracker, IDLE_CONFIRM_MS, UNKNOWN_STALE_MS, RECENT_OUTPUT_MS } from './tracker';
export { agentFromArgv, agentFromArgvTokens, agentFromName, agentFromPsArgs, agentFromTitle, agentCommand, isKnownAgent, isShellName, isRuntimeName, KNOWN_AGENTS } from './agents';
