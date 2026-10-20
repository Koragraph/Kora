// What Kora must never hand to a process it starts (agents, workers, terminal panes, probes).
//
// Children inherit the daemon's environment so the user's own CLIs authenticate as the user would in a terminal
// (ANTHROPIC_API_KEY, OPENAI_API_KEY, gh/aws profiles, proxies…): that stays. What does NOT belong to them are Kora's
// OWN secrets — a KORA_* token/password/key (the UI secret is a file today, but any KORA_*_TOKEN that ever lands in
// the env must not leak), and the signing/notarization secrets of building and releasing Kora itself, present when
// the daemon was started from a release shell. A prompt-injected agent can print its env; these must not be there.
//
// One predicate, applied (a) once to the daemon's own process.env at start (`scrubProcessEnv`, so every spawn path —
// including ones that pass `process.env` straight through, like the SDK chat lane and the model probes — starts
// clean) and (b) again in every pane's base env (`worker-env.ts` `baseEnv`).

/** Kora's own credential-shaped variables. */
const KORA_OWN_SECRET = /^KORA_\w*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|AUTH|TICKET|P12|KEYCHAIN)/i;
/** Code-signing / notarization secrets (electron-builder, notarytool, our release scripts). Never an agent's business. */
const RELEASE_SECRET =
  /^(CSC_(LINK|KEY_PASSWORD|NAME|INSTALLER_LINK|INSTALLER_KEY_PASSWORD|IDENTITY_AUTO_DISCOVERY)|WIN_CSC_(LINK|KEY_PASSWORD)|APPLE_(ID|PASSWORD|APP_SPECIFIC_PASSWORD|API_KEY|API_KEY_ID|API_ISSUER|KEYCHAIN|KEYCHAIN_PROFILE)|KEYCHAIN_PASSWORD|NOTARIZE_\w+|P12_PASSWORD)$/;

export function isKoraOwnSecret(name: string): boolean {
  return KORA_OWN_SECRET.test(name) || RELEASE_SECRET.test(name);
}

/** A copy of `env` without Kora's own secrets (and without undefined values). */
export function scrubChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !isKoraOwnSecret(k)) out[k] = v;
  return out;
}

/** Remove Kora's own secrets from this process's env (the daemon, at start). Returns the names removed. */
export function scrubProcessEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const k of Object.keys(env)) if (isKoraOwnSecret(k)) { delete env[k]; removed.push(k); }
  return removed;
}
