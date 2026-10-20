'use strict';
// Shared isolated environment for the swarm e2e: its own KORA_HOME, socket, UI port and graph DB, so the user's
// running daemon (~/.kora, :8797) is never touched. OpenCode is borrowed from the real ~/.kora/tools via symlink.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../..'); // the kora checkout
const RT = path.join(ROOT, 'packages/runtime');
const BIN = path.join(RT, 'bin/kora.js');
// Everything the e2e creates (isolated KORA_HOME, repos, results, profiles) lives outside the checkout.
const BASE = process.env.SWARM_E2E_DIR || path.join(os.tmpdir(), 'kora-swarm-e2e');
const HOME = path.join(BASE, 'home');
const env = {
  KORA_HOME: HOME,
  KORA_SOCKET_PATH: process.env.SWARM_E2E_SOCKET || '/tmp/kora-swarm-e2e.sock', // short: macOS caps socket paths at 104 bytes
  KORA_UI_PORT: process.env.E2E_UI_PORT || '8798',
  KORAGRAPH_HOME: path.join(BASE, 'kg'),
  KORAGRAPH_DB: path.join(BASE, 'graph.db'),
  KORAGRAPH_PRACTICE_DB: path.join(BASE, 'practice.db'),
};
function childEnv() {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(KORA_|KORAGRAPH_|CLAUDE_CODE_|CLAUDECODE)/.test(k)) delete e[k];
  e.PATH = `${os.homedir()}/.nvm/versions/node/v24.11.1/bin:${e.PATH}`;
  return { ...e, ...env };
}
function prepareHome() {
  fs.mkdirSync(path.join(HOME, 'tools'), { recursive: true });
  const oc = path.join(HOME, 'tools', 'opencode');
  if (!fs.existsSync(oc)) fs.symlinkSync(path.join(os.homedir(), '.kora', 'tools', 'opencode'), oc);
  const cfgPath = path.join(HOME, 'config.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  cfg.swarm = { ...(cfg.swarm || {}), consent: { noticeVersion: 1, acceptedAt: Date.now() } };
  cfg.trustedRoots = [path.join(BASE, 'repos'), path.join(HOME, 'worktrees')];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  // Antigravity has no isolated home: the daemon would run the user's real `agy models` / `agy -p /usage` at boot (agy opens
  // sign-in tabs when its refresh fails). Point the harness at a missing agy (deep audit A3-7 did this for the QA stacks).
  const engPath = path.join(HOME, 'engines.json');
  if (!fs.existsSync(engPath)) fs.writeFileSync(engPath, JSON.stringify({ executables: { antigravity: path.join(BASE, 'no-agy', 'agy') } }, null, 2));
}
module.exports = { ROOT, RT, BIN, BASE, HOME, env, childEnv, prepareHome };
