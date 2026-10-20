// `kora swarm` — Swarm mode setup from the terminal: status, the interactive setup, the pinned OpenCode install,
// provider keys, probes and the model list. Writes (keys, consent, install) run IN-PROCESS on the same module
// functions the daemon uses; afterwards the CLI asks a running daemon for `swarm.getStatus {probe:true}` so it drops
// its caches (ref-reconciled R1: the socket carries only getStatus/reportEvent/setAgentMode).
// A key is never taken from argv (shell history) and never printed — only its keyHint.
import type { IO } from '../main';
import { parseArgs, str, json } from './_shared';
import { defaultSocketPath } from '../../protocol/types';
import { isProEdition, proOnlyMessage } from '../../edition';
import type { SwarmInstallState, SwarmLocalProviderId, SwarmProviderId, SwarmProviderStatus, SwarmStatus, SwarmSupplyProviderId } from '../../protocol/types';
import type { SwarmLocalStatus, SwarmSupplyState } from '../../server/swarm-setup';
import { opencodeInstallFallback } from '../../util/platform-copy';

export const summary = 'Swarm mode (free-model OpenCode workers): status | setup | install | key set|clear | test | models | usage';
export const usage = `kora swarm status [--probe] [--json]      readiness: OpenCode, privacy consent, providers, free models
kora swarm setup                          interactive: privacy notice → install OpenCode → optional keys → test → skill
kora swarm install [--version V] [--yes]  download the pinned OpenCode release into ~/.kora/tools/opencode (sha256-checked)
kora swarm backend                        which program runs swarm workers (OpenCode; Koragent is Kora Pro)
kora swarm key set <provider> [--stdin]   store a key in ~/.kora/secrets/swarm.json (0600); prompts hidden, or reads stdin
kora swarm key clear <provider>           remove Kora's stored key (env / opencode auth.json keys stay)
kora swarm test [provider]                probe one provider (zen, openrouter, cerebras, ollama, lmstudio), or every enabled one
kora swarm models [--json]                the models the swarm may use now (free / paid / local, in pick order), cooling ones
kora swarm models stats [--json]          MEASURED per model and task type: first-try pass, bounces, skipped reports, time
kora swarm models prefer <policy>         free-first (default) | paid-first | local-only (nothing leaves this machine)
kora swarm models paid on|off [--cap USD] [--models id,id]   cheap PAID OpenRouter models on your key; spend capped per task
kora swarm models local <ollama|lmstudio> on|off [--url URL] [--models a,b] [--force]   local model servers
kora swarm usage [--days N] [--json]      MEASURED: jobs per Claude window, workers per job, retries, pass rate, worker tokens/cost

Providers: zen (OpenCode Zen), openrouter, cerebras (trial: $5 / 30 days, needs a payment method; off by default);
local servers: ollama, lmstudio (no key). Watchdog: kora config set swarm.watchdog.nudgeAfterMs / reassignAfterMs (ms).
Keys are never accepted as arguments — they would land in your shell history.`;

const PROVIDERS: SwarmProviderId[] = ['zen', 'openrouter', 'cerebras'];
const LOCAL: SwarmLocalProviderId[] = ['ollama', 'lmstudio'];
const LABEL: Record<SwarmSupplyProviderId, string> = { zen: 'OpenCode Zen', openrouter: 'OpenRouter', cerebras: 'Cerebras', ollama: 'Ollama', lmstudio: 'LM Studio' };

/** The privacy notice (ref-ui B2 step 1). Keep in step with SwarmPrivacyNotice (web) and SWARM_PRIVACY_NOTICE_VERSION. */
const PRIVACY_NOTICE = `Free models are free because providers may log your prompts and code and use them to train models.
Anything a worker sees (files in its worktree, your task text) may leave your machine to that provider.
Don't use Swarm on code you can't share.`;
const NOTICE_VERSION = 1;

function setup() {
  const { SwarmSetup } = require('../../server/swarm-setup') as typeof import('../../server/swarm-setup');
  const { SwarmHealth } = require('../../server/swarm-health') as typeof import('../../server/swarm-health');
  return new SwarmSetup({ health: new SwarmHealth() });
}

async function daemonAlive(): Promise<boolean> {
  const { isSocketAlive } = require('../../server/daemon') as typeof import('../../server/daemon');
  return isSocketAlive(defaultSocketPath(), 300);
}

/** Status from the running daemon (it has the live cooling/test state), else computed in-process. */
async function fetchStatus(probe: boolean): Promise<{ status: SwarmStatus; via: 'daemon' | 'local' }> {
  if (await daemonAlive()) {
    try {
      const { callOnce } = require('../../protocol/client') as typeof import('../../protocol/client');
      return { status: await callOnce('swarm.getStatus', probe ? { probe: true } : {}, undefined, 30_000), via: 'daemon' };
    } catch { /* an older daemon without swarm.getStatus: fall through */ }
  }
  return { status: await (await probedSetup()).getStatus({ probe }), via: 'local' };
}

/** An in-process setup whose enabled local servers were probed (localhost, ~ms): without a daemon nothing else has. */
async function probedSetup() {
  const s = setup();
  for (const l of s.supplyState().local) if (l.enabled) await s.testLocal({ provider: l.provider }).catch(() => null);
  return s;
}

/** After an in-process write: make a running daemon re-read (best effort, silent). */
async function nudgeDaemon(): Promise<void> {
  try {
    if (!(await daemonAlive())) return;
    const { callOnce } = require('../../protocol/client') as typeof import('../../protocol/client');
    await callOnce('swarm.getStatus', { probe: true }, undefined, 15_000);
  } catch { /* the daemon picks the change up on its next check anyway */ }
}

function asProvider(v: string | undefined): SwarmProviderId | null {
  return v && (PROVIDERS as string[]).includes(v) ? (v as SwarmProviderId) : null;
}

function fmtTime(ms: number): string { return new Date(ms).toLocaleTimeString(); }

function providerLine(p: SwarmProviderStatus): string {
  const on = p.enabled ? 'on ' : 'off';
  const key = p.hasKey ? `key ${p.keyHint} (${p.keySource})` : p.keyRequired ? 'no key' : 'no key needed so far';
  const t = p.lastTest;
  const test = !t ? 'not tested' : t.ok ? `ok${t.latencyMs != null ? ` ${t.latencyMs} ms` : ''}, ${t.freeModels.length} free model(s)` : `${t.outcome}${t.message ? `: ${t.message}` : ''}`;
  const l = p.limits;
  const lim = l ? ` · ${[l.requestsPerMinute != null ? `${l.requestsPerMinute}/min` : '', l.requestsPerDay != null ? `${l.requestsPerDay}/day` : '', l.remainingToday != null ? `${l.remainingToday} left today` : ''].filter(Boolean).join(', ')}` : '';
  return `  ${LABEL[p.provider].padEnd(13)} ${on}  ${key} · ${test}${lim}`;
}

function supplyLine(sp: SwarmSupplyState): string {
  const paid = sp.paid.enabled ? `paid on (cap $${sp.paid.maxTaskUsd}/task${sp.paid.hasKey ? '' : ', NO OpenRouter key'})` : 'paid off';
  const local = sp.local.map((l) => `${l.provider} ${l.enabled ? (l.lastTest ? (l.lastTest.ok ? `on, ${l.lastTest.freeModels.length} model(s)` : `on, ${l.lastTest.outcome}`) : 'on, not tested') : 'off'}`).join(' · ');
  return `Supply: ${sp.policy} · ${paid} · ${local}`;
}

function localLine(l: SwarmLocalStatus): string {
  const t = l.lastTest;
  const test = !t ? 'not tested' : t.ok ? `ok${t.latencyMs != null ? ` ${t.latencyMs} ms` : ''}, ${t.freeModels.length} tool-capable model(s)` : `${t.outcome}${t.message ? `: ${t.message}` : ''}`;
  return `  ${LABEL[l.provider].padEnd(13)} ${l.enabled ? 'on ' : 'off'}  ${l.baseUrl} · ${test}`;
}

function formatStatus(s: SwarmStatus, via: string, supply?: SwarmSupplyState): string {
  const lines: string[] = [];
  lines.push(`Swarm: ${s.ready ? 'READY' : 'not ready'}${via === 'daemon' ? '' : ' (computed locally; the daemon is not running)'}`);
  for (const b of s.blockers) lines.push(`  ✗ ${b.message}`);
  const wb = s.workerBackend;
  if (wb && wb.id === 'koragent') {
    const ver = wb.installed ? ` · ${wb.version ?? 'no --version answer'}${wb.versionOk === false ? ` — needs ${wb.minVersion}+` : ''}` : '';
    const pin = wb.pinned ? ` · sha256 ${wb.pinned.slice(0, 12)}… ${wb.pinOk ? 'matches' : 'MISMATCH'}` : wb.installed ? ' · not pinned (not installed by Kora)' : '';
    lines.push(`Worker backend: koragent — ${wb.installed ? `${wb.path} (${wb.source})${ver}${pin}` : 'NOT INSTALLED: kora swarm install --backend koragent --from <binary>'}`);
  } else lines.push(isProEdition() ? 'Worker backend: opencode (kora swarm backend koragent to switch)' : 'Worker backend: opencode');
  const o = s.opencode;
  lines.push(`OpenCode: ${o.installed ? `${o.version ?? 'unknown version'} at ${o.path} (${o.source})${o.versionOk ? '' : ` — needs ${o.minVersion}+`}` : 'not installed — kora swarm install'}`);
  if (s.install.phase !== 'idle') lines.push(`  install: ${s.install.phase}${s.install.message ? ` — ${s.install.message}` : ''}`);
  const c = s.consent;
  lines.push(`Privacy notice: ${c.acceptedVersion != null && c.acceptedVersion >= c.requiredVersion ? `accepted v${c.acceptedVersion} on ${new Date(c.acceptedAt ?? 0).toLocaleString()}` : `not accepted (v${c.requiredVersion}) — kora swarm setup`}`);
  lines.push('Providers:');
  for (const p of s.providers) lines.push(providerLine(p));
  lines.push(`Models: ${s.models.available.length} available${s.models.cooling.length ? `, ${s.models.cooling.length} cooling` : ''}`);
  for (const m of s.models.available.slice(0, 8)) lines.push(`  ${m.id}`);
  if (s.models.available.length > 8) lines.push(`  … ${s.models.available.length - 8} more (kora swarm models)`);
  lines.push(`Preferences: order ${s.preferences.providerOrder.join(' → ')} · default model ${s.preferences.defaultModel ?? 'automatic'} · max ${s.preferences.maxWorkers} workers`);
  if (supply) lines.push(supplyLine(supply));
  lines.push('Keys: stored in a private file in ~/.kora (secrets/swarm.json, mode 0600)');
  return lines.join('\n') + '\n';
}

// ---- terminal input -------------------------------------------------------------------------------------------------

const isTty = () => !!process.stdin.isTTY;

function ask(io: IO, question: string): Promise<string> {
  const readline = require('node:readline') as typeof import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: isTty() });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}
async function yes(io: IO, question: string): Promise<boolean> { return /^y(es)?$/i.test(await ask(io, `${question} [y/N] `)); }

/** Read a line without echoing it (raw mode). Ctrl-C aborts. */
function askHidden(io: IO, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    io.err(prompt);
    let buf = '';
    const done = (err: Error | null) => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(false); } catch { /* not a tty */ }
      stdin.pause();
      io.err('\n');
      if (err) reject(err); else resolve(buf.trim());
    };
    const onData = (d: Buffer) => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(null);
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8').trim();
}

// ---- actions --------------------------------------------------------------------------------------------------------

function progressLine(s: SwarmInstallState): string {
  const mb = (n: number) => (n / 1048576).toFixed(1);
  if (s.phase === 'downloading') return `downloading ${mb(s.downloadedBytes)}${s.totalBytes ? ` / ${mb(s.totalBytes)}` : ''} MB`;
  return `${s.phase}${s.message ? ` — ${s.message}` : ''}`;
}

async function doInstall(io: IO, version: string | undefined): Promise<number> {
  const { installOpencode, OPENCODE_PINNED_VERSION } = require('../../server/swarm-install') as typeof import('../../server/swarm-install');
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.once('SIGINT', onSig);
  let last = '';
  try {
    io.err(`Installing OpenCode v${(version ?? OPENCODE_PINNED_VERSION).replace(/^v/, '')} into ~/.kora/tools/opencode …\n`);
    const final = await installOpencode({
      ...(version ? { version } : {}),
      signal: ac.signal,
      onProgress: (s) => {
        const line = progressLine(s);
        if (line === last) return; last = line;
        if (isTty() && process.stderr.isTTY) process.stderr.write(`\r\x1b[2K  ${line}`); else if (s.phase !== 'downloading') io.err(`  ${line}\n`);
      },
    });
    if (isTty() && process.stderr.isTTY) io.err('\n');
    await nudgeDaemon();
    if (final.phase === 'succeeded') { io.out(`${final.message}\n`); return 0; }
    io.err(`kora swarm install: ${final.message ?? final.phase}\n`);
    return 1;
  } finally { process.removeListener('SIGINT', onSig); }
}

async function doInstallKoragent(io: IO, flags: Record<string, string | boolean | undefined>): Promise<number> {
  const ki = require('../../server/koragent-install') as typeof import('../../server/koragent-install');
  const from = str(flags.from) ?? null; const build = str(flags.build) ?? null;
  const target = ki.koragentInstallPath();
  const what = from ?? process.env.KORAGENT_BUILD_PATH ?? (build ? `a build of ${build}` : null);
  if (!what) { io.err('kora swarm install --backend koragent: pass --from <binary|dir|url>, set KORAGENT_BUILD_PATH, or --build <koragent checkout>\n'); return 2; }
  if (!flags.yes) {
    if (!isTty()) { io.err('kora swarm install: pass --yes to install without a prompt\n'); return 2; }
    if (!(await yes(io, `Install Koragent from ${what} into ${target}?`))) { io.err('Not installed.\n'); return 1; }
  }
  const ac = new AbortController(); const onSig = () => ac.abort(); process.once('SIGINT', onSig);
  try {
    const r = await ki.installKoragent({ from, build, sha256: str(flags.sha256) ?? null, signal: ac.signal, onProgress: (m) => io.err(`  ${m}\n`) });
    await nudgeDaemon();
    if (!r.ok) { io.err(`kora swarm install: ${r.message}\n`); return 1; }
    io.out(`${r.message}\n`);
    const { loadConfig } = require('../../config') as typeof import('../../config');
    if (loadConfig().swarm.workerBackend !== 'koragent') io.out('Workers still run on OpenCode; switch with: kora swarm backend koragent\n');
    return 0;
  } finally { process.removeListener('SIGINT', onSig); }
}

async function doTest(io: IO, providers: SwarmProviderId[], asJson: boolean): Promise<number> {
  const s = setup();
  const out: SwarmProviderStatus[] = [];
  for (const p of providers) out.push(await s.testProvider({ provider: p }));
  if (asJson) { json(io, out); return out.every((p) => p.lastTest?.ok) ? 0 : 1; }
  for (const p of out) io.out(providerLine(p) + '\n');
  return out.every((p) => p.lastTest?.ok) ? 0 : 1;
}

async function setKeyInteractive(io: IO, provider: SwarmProviderId, fromStdin: boolean): Promise<number> {
  let key: string;
  if (fromStdin) key = await readStdin();
  else if (isTty()) key = await askHidden(io, `${LABEL[provider]} API key (input hidden): `);
  else { io.err('kora swarm key set: no terminal to prompt on — pipe the key in with --stdin\n'); return 2; }
  if (!key) { io.err('kora swarm key set: no key given; nothing changed\n'); return 1; }
  const st = await setup().setKey({ provider, apiKey: key });
  key = '';
  await nudgeDaemon();
  io.out(`saved ${LABEL[provider]} key ${st.keyHint} to ~/.kora/secrets/swarm.json (0600)${st.enabled ? '' : ` — ${provider} is disabled; enable it in Settings → Swarm`}\n`);
  if (provider === 'openrouter' && !setup().supplyState().paid.enabled) io.out('Cheap paid models (≈ $0.001–0.004 per task, capped) can use this key too: kora swarm models paid on\n');
  return 0;
}

async function runSetup(io: IO): Promise<number> {
  if (!isTty()) { io.err('kora swarm setup is interactive; use kora swarm install / key set --stdin in scripts\n'); return 2; }
  const s = setup();
  // 1. privacy
  io.err(`\nSwarm mode: Claude leads; free models (OpenCode workers) do the delegated work.\n\n${PRIVACY_NOTICE}\n\n`);
  const status0 = await s.getStatus({ probe: true });
  const c = status0.consent;
  if (c.acceptedVersion != null && c.acceptedVersion >= c.requiredVersion) io.err(`Privacy notice already accepted (v${c.acceptedVersion}).\n`);
  else if (await yes(io, 'I understand free-model providers may store and train on what workers send. Accept?')) {
    await s.setConsent({ noticeVersion: NOTICE_VERSION, accepted: true });
    io.err('Accepted.\n');
  } else { io.err('Not accepted — Swarm stays off. Run kora swarm setup again any time.\n'); return 1; }
  // 2. OpenCode
  const o = status0.opencode;
  if (o.installed && o.versionOk) io.err(`\nOpenCode ${o.version} found at ${o.path}.\n`);
  else {
    const { OPENCODE_PINNED_VERSION } = require('../../server/swarm-install') as typeof import('../../server/swarm-install');
    io.err(o.installed ? `\nOpenCode ${o.version ?? '(unknown version)'} at ${o.path} is older than ${o.minVersion}.\n` : '\nOpenCode is not installed.\n');
    if (await yes(io, `Install OpenCode v${OPENCODE_PINNED_VERSION} into ~/.kora/tools/opencode (no sudo, no shell-rc edits)?`)) {
      if (await doInstall(io, undefined) !== 0) io.err(`Install failed; you can also run: ${opencodeInstallFallback()} — then kora swarm status --probe\n`);
    } else io.err('Skipped. Other ways: brew install opencode · curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path\n');
  }
  // 3. keys (optional)
  io.err('\nOpenCode Zen needs no key for its free models (the test below checks). Optional keys add more free models:\n');
  for (const p of ['openrouter', 'cerebras'] as const) {
    const cur = (await s.getStatus()).providers.find((x) => x.provider === p);
    const note = p === 'cerebras' ? ' (trial: $5 / 30 days, needs a payment method; off by default)' : ' (free, 50 requests/day; 1000 with $10 credit)';
    if (cur?.hasKey) { io.err(`${LABEL[p]}: key ${cur.keyHint} (${cur.keySource}) already set.\n`); continue; }
    if (!(await yes(io, `Add a ${LABEL[p]} key${note}?`))) continue;
    const key = await askHidden(io, `${LABEL[p]} API key (input hidden): `);
    if (!key) continue;
    const st = await s.setKey({ provider: p, apiKey: key });
    io.err(`Saved ${st.keyHint}.\n`);
    if (p === 'cerebras' && !st.enabled && (await yes(io, 'Enable Cerebras for swarm workers?'))) await s.setPreferences({ enabled: [{ provider: 'cerebras', enabled: true }] });
  }
  // 4. probes
  io.err('\nTesting providers…\n');
  const cfg = await s.getStatus();
  for (const p of cfg.providers.filter((x) => x.enabled && (x.provider === 'zen' || x.hasKey))) io.err(providerLine(await s.testProvider({ provider: p.provider })) + '\n');
  // 5. the koraswarm skill (S3's installSwarmSkill)
  try {
    const { installSwarmSkill } = require('../../server/swarm-skill') as typeof import('../../server/swarm-skill');
    installSwarmSkill();
    io.err('Installed the koraswarm skill.\n');
  } catch (e: any) { io.err(`Skill not installed (${e?.message || e}); the app installs it when you switch a thread to Swarm.\n`); }
  await nudgeDaemon();
  io.out('\n' + formatStatus(await s.getStatus(), 'local'));
  return 0;
}

export async function run(argv: string[], io: IO): Promise<number> {
  // `kora swarm check --baseline <file> -- <command>`: a worker's done-check judged against its base commit
  // (server/swarm-baseline.ts). Parsed by hand: everything after `--` is the command, verbatim.
  if (argv[0] === 'check') {
    const separator = argv.indexOf('--');
    const bi = argv.indexOf('--baseline');
    const file = bi > 0 && bi < (separator < 0 ? argv.length : separator) ? argv[bi + 1] : undefined;
    const command = separator >= 0 ? argv.slice(separator + 1).join(' ') : '';
    if (!file || !command) { io.err('usage: kora swarm check --baseline <file> -- <command>\n'); return 2; }
    const { checkCommand } = require('../../server/swarm-baseline') as typeof import('../../server/swarm-baseline');
    return checkCommand(file, command, { out: (x) => io.out(x) });
  }
  const { positional, flags } = parseArgs(argv, ['version', 'days', 'cap', 'models', 'url', 'backend', 'from', 'sha256', 'build'], ['json', 'probe', 'yes', 'stdin', 'force']);
  const sub = positional[0] || 'status';
  switch (sub) {
    case 'status': {
      const { status, via } = await fetchStatus(!!flags.probe);
      if (flags.json) json(io, status); else io.out(formatStatus(status, via, (await probedSetup()).supplyState()));
      return 0;
    }
    case 'setup': return runSetup(io);
    case 'install': {
      const backend = str(flags.backend);
      if (backend && backend !== 'opencode' && backend !== 'koragent') { io.err('kora swarm install: --backend is opencode or koragent\n'); return 2; }
      if (backend === 'koragent') {
        if (!isProEdition()) { io.err(`${proOnlyMessage('Koragent')}\n`); return 2; }
        return doInstallKoragent(io, flags);
      }
      const version = str(flags.version);
      if (!flags.yes) {
        if (!isTty()) { io.err('kora swarm install: pass --yes to install without a prompt\n'); return 2; }
        const { OPENCODE_PINNED_VERSION } = require('../../server/swarm-install') as typeof import('../../server/swarm-install');
        if (!(await yes(io, `Install OpenCode v${(version ?? OPENCODE_PINNED_VERSION).replace(/^v/, '')} into ~/.kora/tools/opencode?`))) { io.err('Not installed.\n'); return 1; }
      }
      return doInstall(io, version);
    }
    case 'key': {
      const action = positional[1]; const provider = asProvider(positional[2]);
      if (!provider || (action !== 'set' && action !== 'clear')) { io.err(`usage: kora swarm key set|clear <${PROVIDERS.join('|')}> [--stdin]\n`); return 2; }
      if (positional.length > 3) { io.err('kora swarm key: never pass a key as an argument (it lands in your shell history) — use the hidden prompt or --stdin\n'); return 2; }
      if (action === 'clear') {
        const st = await setup().clearKey({ provider });
        await nudgeDaemon();
        io.out(`cleared Kora's ${LABEL[provider]} key${st.hasKey ? ` — a key from ${st.keySource} (${st.keyHint}) is still in effect` : ''}\n`);
        return 0;
      }
      return setKeyInteractive(io, provider, !!flags.stdin);
    }
    case 'test': {
      const one = positional[1];
      if (one && (LOCAL as string[]).includes(one)) {
        const l = await setup().testLocal({ provider: one as SwarmLocalProviderId });
        if (flags.json) json(io, l); else io.out(localLine(l) + '\n');
        return l.lastTest?.ok ? 0 : 1;
      }
      if (one && !asProvider(one)) { io.err(`kora swarm test: unknown provider ${one} (${[...PROVIDERS, ...LOCAL].join(', ')})\n`); return 2; }
      let list: SwarmProviderId[];
      if (one) list = [one as SwarmProviderId];
      else list = (await setup().getStatus()).providers.filter((p) => p.enabled).map((p) => p.provider);
      if (!list.length) { io.err('kora swarm test: no provider is enabled\n'); return 1; }
      return doTest(io, list, !!flags.json);
    }
    case 'models': return runModels(positional.slice(1), flags, io);
    case 'backend': {
      const want = positional[1];
      const { loadConfig, saveConfig } = require('../../config') as typeof import('../../config');
      if (!want) { io.out(`${loadConfig().swarm.workerBackend}\n`); return 0; }
      if (want !== 'opencode' && want !== 'koragent') { io.err('usage: kora swarm backend opencode|koragent\n'); return 2; }
      if (want === 'koragent' && !isProEdition()) { io.err(`${proOnlyMessage('Koragent')}\n`); return 2; }
      saveConfig({ swarm: { workerBackend: want } });
      await nudgeDaemon();
      io.out(`swarm workers now run on ${want} (new tasks; running ones keep theirs)\n`);
      if (want === 'koragent') {
        const { status } = await fetchStatus(true);
        for (const b of status.blockers.filter((x) => x.code.startsWith('koragent'))) io.out(`  ✗ ${b.message}\n`);
      }
      return 0;
    }
    case 'usage': {
      const days = Math.max(1, Number(str(flags.days) ?? 7) || 7);
      const u = require('../../server/swarm-usage') as typeof import('../../server/swarm-usage');
      const r = u.usageReport(days);
      if (flags.json) json(io, r); else io.out(u.formatReport(r, days));
      return 0;
    }
    default: io.err(usage + '\n'); return 2;
  }
}

// ---- kora swarm models … -------------------------------------------------------------------------------------------

const pct = (x: number | null) => (x == null ? '   –' : `${String(Math.round(x * 100)).padStart(3)}%`);
const csv = (v: unknown): string[] | undefined => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

async function runModels(args: string[], flags: Record<string, unknown>, io: IO): Promise<number> {
  const sub = args[0] ?? 'list';
  const s = setup();
  try {
    switch (sub) {
      case 'list': {
        const { status } = await fetchStatus(false);
        const { modelTier } = require('../../server/swarm-health') as typeof import('../../server/swarm-health');
        const { paidPrice } = require('../../server/swarm-catalog') as typeof import('../../server/swarm-catalog');
        const r = require('../../server/swarm-routing') as typeof import('../../server/swarm-routing');
        const stats = r.loadRoutingStats();
        const rows = status.models.available.map((m) => {
          const sc = r.scoreModel(stats, m.id, null);
          return { ...m, tier: modelTier(m.id), price: modelTier(m.id) === 'paid' ? paidPrice(m.id) : null,
            expectedPass: Math.round(sc.quality * 100) / 100, reliability: Math.round(sc.supply * 100) / 100, medianSec: Math.round(sc.medianMs / 1000), observations: Math.round(sc.n * 10) / 10 };
        });
        const supply = (await probedSetup()).supplyState();
        if (flags.json) { json(io, { available: rows, cooling: status.models.cooling, supply }); return 0; }
        io.out(supplyLine(supply) + '\n');
        if (!rows.length) io.out('No model is available right now (kora swarm status shows why).\n');
        else io.out(`${'model (tier order)'.padEnd(52)} ${'tier'.padEnd(5)} pass  rel  ~time  seen\n`);
        for (const m of rows) {
          const price = m.price ? ` · $${m.price.input}/$${m.price.output} per M` : '';
          io.out(`${m.id.padEnd(52)} ${m.tier.padEnd(5)} ${pct(m.expectedPass)} ${pct(m.reliability)} ${String(Math.round(m.medianSec / 60)).padStart(3)} min ${String(m.observations).padStart(5)}${m.maxConcurrent != null ? ` · ≤${m.maxConcurrent} at once` : ''}${price}\n`);
        }
        for (const c of status.models.cooling) io.out(`${c.model.padEnd(52)} cooling until ${fmtTime(c.until)} (${c.reason})\n`);
        io.out('pass = expected first-try pass, rel = not rate-limited (measured outcomes + priors; kora swarm models stats for the raw table)\n');
        return 0;
      }
      case 'stats': {
        const r = require('../../server/swarm-routing') as typeof import('../../server/swarm-routing');
        const rows = r.readOutcomeRows();
        const table = r.modelStatsTable(rows);
        if (flags.json) { json(io, { rows: rows.length, models: table }); return 0; }
        if (!table.length) { io.out('No finished swarm tasks yet (~/.kora/swarm/outcomes.jsonl is empty). Routing uses its built-in priors until then.\n'); return 0; }
        io.out(`${rows.length} finished task(s) in ~/.kora/swarm/outcomes.jsonl\n`);
        io.out(`${'model'.padEnd(44)} ${'type'.padEnd(8)} tries  pass bounce skip stall  429  median\n`);
        for (const x of table) io.out(`${(x.type === 'all' ? x.model : '').padEnd(44)} ${x.type.padEnd(8)} ${String(x.attempts).padStart(5)} ${pct(x.firstTryPass)} ${pct(x.bounceRate)} ${pct(x.reportSkipRate)} ${pct(x.stallRate)} ${pct(x.refusedRate)} ${x.medianSec == null ? '     –' : `${String(x.medianSec).padStart(5)}s`}\n`);
        return 0;
      }
      case 'prefer': {
        const policy = args[1] as any;
        if (!['free-first', 'paid-first', 'local-only'].includes(policy)) { io.err('usage: kora swarm models prefer free-first|paid-first|local-only\n'); return 2; }
        await s.setSupply({ policy });
        await nudgeDaemon();
        const st = (await probedSetup()).supplyState();
        io.out(supplyLine(st) + '\n');
        if (policy === 'local-only' && !st.local.some((l) => l.enabled)) io.out('No local server is enabled yet: kora swarm models local ollama on\n');
        if (policy === 'paid-first' && !st.paid.enabled) io.out('Paid models are off: kora swarm models paid on\n');
        return 0;
      }
      case 'paid': {
        const on = args[1];
        if (on !== 'on' && on !== 'off' && flags.cap === undefined && flags.models === undefined) { io.err('usage: kora swarm models paid on|off [--cap USD] [--models id,id]\n'); return 2; }
        const cap = flags.cap !== undefined ? Number(flags.cap) : undefined;
        const st = await s.setSupply({ paid: { ...(on === 'on' || on === 'off' ? { enabled: on === 'on' } : {}), ...(cap !== undefined ? { maxTaskUsd: cap } : {}), ...(csv(flags.models) ? { models: csv(flags.models)! } : {}) } });
        await nudgeDaemon();
        io.out(supplyLine({ ...st, local: (await probedSetup()).supplyState().local }) + '\n');
        if (st.paid.enabled) io.out(`Paid OpenRouter models are used ${st.policy === 'paid-first' ? 'first' : 'after the free tiers'}; a task is stopped at $${st.paid.maxTaskUsd}.\n`);
        return 0;
      }
      case 'local': {
        const provider = args[1] as SwarmLocalProviderId; const on = args[2];
        if (!(LOCAL as string[]).includes(provider) || (on !== undefined && on !== 'on' && on !== 'off')) { io.err('usage: kora swarm models local ollama|lmstudio on|off [--url URL] [--models a,b] [--force]\n'); return 2; }
        const st = await s.setSupply({ local: { provider, ...(on ? { enabled: on === 'on' } : {}), ...(typeof flags.url === 'string' ? { baseUrl: flags.url } : {}), ...(csv(flags.models) ? { models: csv(flags.models)! } : {}), ...(flags.force ? { force: true } : {}) } });
        await nudgeDaemon();
        const l = st.local.find((x) => x.provider === provider)!;
        io.out(localLine(l) + '\n');
        if (l.enabled && l.lastTest?.ok) io.out(`Workers can now run on ${l.lastTest.freeModels.slice(0, 5).join(', ')}${st.policy === 'local-only' ? '' : ` (used ${st.policy === 'free-first' ? 'after the free remote tiers' : 'last'}; kora swarm models prefer local-only to keep code on this machine)`}.\n`);
        if (provider === 'ollama' && l.enabled) io.out('Tip: agent prompts are long — give Ollama a large context (OLLAMA_CONTEXT_LENGTH=32768 or more).\n');
        return 0;
      }
      default: io.err(usage + '\n'); return 2;
    }
  } catch (e: any) { io.err(`kora swarm models: ${e?.message ?? e}\n`); return 1; }
}
