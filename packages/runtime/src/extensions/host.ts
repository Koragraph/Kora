// The daemon side of the `extensions.*` RPCs (bound as UiHost.extensions in server/ui.ts). Converts between the stored
// model and the wire shape; a secret value never leaves the daemon (it goes out as `{ secret: true, value: null }`).
import { CATALOG } from './catalog';
import * as ext from './index';
import { AGENT_LABELS, EXTENSION_AGENTS, isSecretRef, type ExtensionAgent, type McpServer, type Value } from './model';
import { parseServerInput } from './parse';
import { forgetSecrets, loadExtensions, removeServer } from './store';

interface WireKV { key: string; value: string | null; secret: boolean }
export interface WireServer {
  name: string; transport: 'stdio' | 'http'; command: string | null; args: string[]; env: WireKV[]; url: string | null; headers: WireKV[];
  enabled: boolean; agents: ExtensionAgent[]; workers: boolean; folders: string[]; source: string | null;
}

const toKV = (rec: Record<string, Value> | undefined, secretKeys: string[] = []): WireKV[] =>
  Object.entries(rec ?? {}).map(([key, v]) => isSecretRef(v)
    ? { key, value: null, secret: true }
    : { key, value: v, secret: secretKeys.includes(key) });

export function toWire(s: Partial<McpServer> & { name: string }, secretKeys: { env?: string[]; header?: string[] } = {}): WireServer {
  return {
    name: s.name, transport: s.transport === 'http' ? 'http' : 'stdio', command: s.command ?? null, args: s.args ?? [],
    env: toKV(s.env, secretKeys.env), url: s.url ?? null, headers: toKV(s.headers, secretKeys.header),
    enabled: s.enabled !== false, agents: s.agents?.length ? [...s.agents] : [...EXTENSION_AGENTS], workers: s.workers === true,
    folders: s.folders ?? [], source: s.source ?? null,
  };
}

/**
 * A wire server back to the model. A secret entry without a new value keeps the saved reference (looked up from the
 * stored definition under `previousName`); a secret entry with a literal value from a draft becomes a new secret.
 */
function fromWire(w: WireServer, previous: McpServer | undefined, newSecrets: Map<string, string>): { server: Partial<McpServer> & { name: string }; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  const build = (list: WireKV[], kind: 'env' | 'header', old: Record<string, Value> | undefined) => {
    const out: Record<string, Value> = {};
    for (const kv of list) {
      if (!kv.key.trim()) continue;
      const slot = `${kind}:${kv.key}`;
      const fresh = newSecrets.get(slot) ?? (kv.secret && kv.value ? kv.value : undefined);
      if (fresh !== undefined) { secrets[slot] = fresh; continue; }
      if (kv.secret) {
        const kept = old?.[kv.key];
        if (kept && isSecretRef(kept)) out[kv.key] = kept;
        else throw new Error(`Enter a value for ${kv.key}.`);
        continue;
      }
      out[kv.key] = kv.value ?? '';
    }
    return out;
  };
  const server: Partial<McpServer> & { name: string } = {
    name: w.name.trim(), transport: w.transport, enabled: w.enabled, agents: w.agents, workers: w.workers,
    ...(w.folders.length ? { folders: w.folders } : {}), ...(w.source ? { source: w.source } : {}),
  };
  if (w.transport === 'stdio') {
    server.command = w.command ?? '';
    server.args = w.args;
    server.env = build(w.env, 'env', previous?.env);
  } else {
    server.url = w.url ?? '';
    server.headers = build(w.headers, 'header', previous?.headers);
  }
  return { server, secrets };
}

const deliveries: Record<ExtensionAgent, string> = {
  claude: 'Passed to each Claude Code session and worker at launch.',
  codex: 'Passed to each Codex turn at launch (secrets through environment variables, never the command line).',
  opencode: 'Passed to each OpenCode run in its configuration.',
  antigravity: "Kept in Antigravity's own ~/.gemini/config/mcp_config.json (Antigravity has no per-launch option); folder limits do not apply there.",
};

const onlyRefsNotIn = (rec: Record<string, Value> | undefined, keep: Set<string>) =>
  rec ? Object.fromEntries(Object.entries(rec).filter(([, v]) => isSecretRef(v) && !keep.has(v.secret))) : undefined;

const byName = (name: string) => loadExtensions().mcpServers.find((s) => s.name.toLowerCase() === name.toLowerCase());

export const extensionsHostApi = {
  list() {
    const x = loadExtensions();
    return {
      servers: x.mcpServers.map((s) => toWire(s)),
      skills: x.skills.map((k) => {
        const links = ext.skillLinks(k);
        return { name: k.name, description: k.description, enabled: k.enabled, agents: k.agents, linkedFor: EXTENSION_AGENTS.filter((a) => links[a]), source: k.source ?? null };
      }),
      agents: EXTENSION_AGENTS.map((id) => ({ id, label: AGENT_LABELS[id], delivery: deliveries[id] })),
    };
  },
  async save(input: { server: WireServer; secrets: { slot: string; value: string }[]; previousName: string | null }) {
    const previous = byName(input.previousName ?? input.server.name);
    const { server, secrets } = fromWire(input.server, previous, new Map(input.secrets.map((s) => [s.slot, s.value])));
    const renamed = !!input.previousName && input.previousName.toLowerCase() !== server.name.toLowerCase();
    if (renamed) {
      if (byName(server.name)) throw new Error(`An extension named "${server.name}" already exists.`);
      // The old entry goes; keychain values the new definition still references (kept secrets) stay.
      removeServer(input.previousName!);
      const kept = new Set([...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})].filter(isSecretRef).map((v) => v.secret));
      if (previous) await forgetSecrets({ ...previous, env: onlyRefsNotIn(previous.env, kept), headers: onlyRefsNotIn(previous.headers, kept) });
    }
    return toWire(await ext.saveServer({ server, secrets }));
  },
  async remove(input: { name: string }) { return { ok: await ext.deleteServer(input.name) }; },
  setEnabled(input: { name: string; enabled: boolean }) { return toWire(ext.enableServer(input.name, input.enabled)); },
  async test(input: { name: string | null; draft: WireServer | null; secrets: { slot: string; value: string }[] }) {
    const newSecrets = new Map(input.secrets.map((s) => [s.slot, s.value]));
    let r;
    if (input.draft) {
      const previous = byName(input.draft.name);
      const { server, secrets } = fromWire(input.draft, previous, newSecrets);
      r = await ext.test(server, { secrets });
    } else r = await ext.test(input.name ?? '');
    return { ok: r.ok, ms: r.ms, tools: r.tools, serverName: r.serverName ?? null, serverVersion: r.serverVersion ?? null, error: r.error ?? null, stderr: r.stderr ?? null };
  },
  parse(input: { text: string; name: string | null }) {
    const p = parseServerInput(input.text, input.name ?? undefined);
    return {
      servers: p.servers.map((s) => {
        const slots = p.secretKeys[s.name] ?? [];
        return toWire(s, { env: slots.filter((k) => k.startsWith('env:')).map((k) => k.slice(4)), header: slots.filter((k) => k.startsWith('header:')).map((k) => k.slice(7)) });
      }),
      warnings: p.warnings,
    };
  },
  discover() {
    return {
      items: ext.discover().map((g) => {
        const p = parseServerInput(JSON.stringify({ mcpServers: { [g.server.name]: g.server.transport === 'http' ? { url: g.server.url, headers: g.server.headers } : { command: g.server.command, args: g.server.args, env: g.server.env } } }));
        const slots = p.secretKeys[g.server.name] ?? [];
        return {
          server: toWire({ ...g.server, ...(g.folders.length ? { folders: g.folders } : {}), source: `import:${g.agents[0]}` }, { env: slots.filter((k) => k.startsWith('env:')).map((k) => k.slice(4)), header: slots.filter((k) => k.startsWith('header:')).map((k) => k.slice(7)) }),
          foundIn: g.agents, alreadyAdded: g.alreadyAdded,
        };
      }),
    };
  },
  catalog() {
    const have = new Set(loadExtensions().mcpServers.map((s) => s.source));
    return {
      entries: CATALOG.map((e) => ({
        id: e.id, title: e.title, description: e.description, homepage: e.homepage, needs: e.needs, transport: e.server.transport,
        params: e.params.map((p) => ({ key: p.key, label: p.label, kind: p.kind, secret: p.secret === true, required: p.required === true, placeholder: p.placeholder ?? null, help: p.help ?? null })),
        added: have.has(`catalog:${e.id}`),
      })),
    };
  },
  async addFromCatalog(input: { id: string; answers: Record<string, string>; agents: ExtensionAgent[]; workers: boolean }) {
    const saved = await ext.saveServer(ext.fromCatalog(input.id, input.answers, { ...(input.agents.length ? { agents: input.agents } : {}), workers: input.workers }));
    return toWire(saved);
  },
  project(input: { cwd: string }) {
    const r = ext.projectServers(input.cwd);
    return { root: r.root, servers: r.servers.map((p) => ({ server: toWire(p.server), approved: p.approved, secretLabels: p.secretLabels, missingSecrets: p.missingSecrets })) };
  },
  projectApprove(input: { cwd: string; name: string; approved: boolean }) { ext.setProjectServerApproved(input.cwd, input.name, input.approved); return { ok: true }; },
  async setProjectSecret(input: { label: string; value: string }) {
    if (!input.label.trim() || !input.value.trim()) throw new Error('A label and a value are required.');
    await ext.saveProjectSecret(input.label.trim(), input.value.trim());
    return { ok: true };
  },
  async skillAdd(input: { source: string; agents: ExtensionAgent[] }) {
    const r = await ext.installSkills(input.source, input.agents.length ? { agents: input.agents } : {});
    return {
      installed: r.installed.map((k) => ({ name: k.name, description: k.description, enabled: k.enabled, agents: k.agents, linkedFor: EXTENSION_AGENTS.filter((a) => ext.skillLinks(k)[a]), source: k.source ?? null })),
      skipped: r.skipped,
    };
  },
  skillRemove(input: { name: string }) { return { ok: ext.removeSkill(input.name) }; },
  skillSetEnabled(input: { name: string; enabled: boolean }) {
    const k = ext.setSkillEnabled(input.name, input.enabled);
    return { name: k.name, description: k.description, enabled: k.enabled, agents: k.agents, linkedFor: EXTENSION_AGENTS.filter((a) => ext.skillLinks(k)[a]), source: k.source ?? null };
  },
};

export type ExtensionsHostApi = typeof extensionsHostApi;
