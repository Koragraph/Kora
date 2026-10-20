// Scrub credentials out of free text before it is persisted (server.log, outcomes.jsonl) or shown. Pattern-based:
// the well-known key shapes (Anthropic, OpenAI, OpenRouter, Cerebras, GitHub, AWS, Slack, npm, Google), a Bearer
// header, and `key=value` pairs whose name says secret (a value with a letter in it: `outputTokens: 123456789` stays). Keeps a short vendor prefix so a log still says WHICH key.
const SHAPES: RegExp[] = [
  /\b(sk-ant-(?:api|admin)\d{2}-)[A-Za-z0-9_-]{16,}/g,
  /\b(sk-or-v\d-)[A-Za-z0-9]{16,}/g,
  /\b(sk-(?:proj-|svcacct-)?)[A-Za-z0-9_-]{20,}/g,
  /\b(csk-)[A-Za-z0-9]{16,}/g,
  /\b(gh[pousr]_)[A-Za-z0-9]{20,}/g,
  /\b(github_pat_)[A-Za-z0-9_]{20,}/g,
  /\b((?:AKIA|ASIA))[A-Z0-9]{16}\b/g,
  /\b(xox[abposr]-)[A-Za-z0-9-]{10,}/g,
  /\b(npm_)[A-Za-z0-9]{30,}/g,
  /\b(AIza)[A-Za-z0-9_-]{30,}/g,
];
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
const ASSIGN = /\b([A-Za-z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*["']?\s*[=:]\s*["']?)((?=[^\s"',}]*[A-Za-z])[^\s"',}]{8,})/gi;

export function redactSecrets(text: string): string {
  if (!text) return text;
  let s = text;
  for (const re of SHAPES) s = s.replace(re, '$1[REDACTED]');
  s = s.replace(BEARER, '$1[REDACTED]');
  s = s.replace(ASSIGN, (m, name: string, value: string) => (value === '[REDACTED]' || value.endsWith('[REDACTED]') ? m : `${name}[REDACTED]`));
  return s;
}
