import type { IO } from '../main';

export const summary = 'Extensions: MCP servers and skills for every agent (add once, Claude Code / Codex / OpenCode / Antigravity all get them)';
export const usage = `Usage: kora ext list [--json]
       kora ext add <name> -- <command> [args…]      a local (stdio) server
       kora ext add <name> <https://url>              a remote server
       kora ext add --paste                            read a README snippet from stdin ({"mcpServers": …}, TOML, a command)
       kora ext add --catalog <id> [--set KEY=VALUE…] a server from \`kora ext catalog\`
         options: --env KEY=VALUE  --secret KEY (value read from stdin, kept in the keychain)  --header "Name: value"
                  --agents claude,codex,opencode,antigravity  --workers  --folder <path>
       kora ext remove|enable|disable <name>
       kora ext test <name>                            start it, list its tools
       kora ext import [--yes]                         servers already configured in the agents' own files
       kora ext catalog
       kora ext project [--allow <name>|--revoke <name>]  a repo's shared servers (.kora/extensions.json) and their approval
       kora ext secret set <label>                      a value a repo's servers ask for ({"secret": "<label>"}), from stdin
       kora ext skill add <folder|git-url> [--agents …] | skill remove <name> | skill list

Extensions live in ~/.kora/extensions.json; secret values in the macOS Keychain. A repository can share servers in
.kora/extensions.json (loaded only in folders you trust in Kora). Settings › Extensions does the same in the app.`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function run(argv: string[], io: IO): Promise<number> {
  const ext = require('../../extensions') as typeof import('../../extensions');
  const [verb, ...rest] = argv;
  const flag = (k: string) => rest.includes(k);
  const values = (k: string) => rest.flatMap((a, i) => (a === k && rest[i + 1] !== undefined ? [rest[i + 1]!] : []));
  const one = (k: string) => values(k)[0];
  const agentsOpt = () => {
    const raw = one('--agents');
    if (!raw) return undefined;
    const list = raw.split(',').map((a) => a.trim());
    const bad = list.filter((a) => !ext.isExtensionAgent(a));
    if (bad.length) throw new Error(`unknown agent ${bad.join(', ')} (use ${ext.EXTENSION_AGENTS.join(', ')})`);
    return list as import('../../extensions').ExtensionAgent[];
  };
  try {
    if (verb === 'exec') return await execServer(rest[0], io);
    if (!verb || verb === 'list') {
      const x = ext.loadExtensions();
      if (flag('--json')) { io.out(JSON.stringify(x, null, 2) + '\n'); return 0; }
      if (!x.mcpServers.length && !x.skills.length) { io.out('No extensions yet. Try: kora ext catalog, kora ext import, or kora ext add <name> -- <command>\n'); return 0; }
      for (const s of x.mcpServers) {
        const where = s.transport === 'http' ? s.url : [s.command, ...(s.args ?? [])].join(' ');
        io.out(`${s.enabled ? '●' : '○'} ${s.name.padEnd(22)} ${s.agents.join(',').padEnd(34)} ${s.workers ? 'chat+workers' : 'chat'}  ${where}\n`);
      }
      for (const k of x.skills) io.out(`${k.enabled ? '●' : '○'} skill ${k.name.padEnd(16)} ${k.agents.join(',')}  ${k.description.slice(0, 60)}\n`);
      return 0;
    }
    if (verb === 'catalog') {
      for (const e of ext.CATALOG) io.out(`${e.id.padEnd(20)} ${e.title.padEnd(20)} ${e.description}${e.needs ? `  (needs ${e.needs})` : ''}\n`);
      return 0;
    }
    if (verb === 'add') {
      const common = { ...(agentsOpt() ? { agents: agentsOpt()! } : {}), workers: flag('--workers'), ...(values('--folder').length ? { folders: values('--folder').map((f) => require('node:path').resolve(f)) } : {}) };
      let input: import('../../extensions').SaveInput;
      const catalogId = one('--catalog');
      if (catalogId) {
        const answers = Object.fromEntries(values('--set').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
        input = ext.fromCatalog(catalogId, answers, common);
      } else {
        const separator = argv.indexOf('--');
        let text: string;
        let name: string | undefined;
        if (flag('--paste')) text = await readStdin();
        else if (separator >= 0) { name = rest[0]; text = argv.slice(separator + 1).map((w) => (/\s/.test(w) ? JSON.stringify(w) : w)).join(' '); }
        else { name = rest[0]; text = rest[1] ?? ''; }
        const parsed = ext.parseInput(text, name);
        parsed.warnings.forEach((w) => io.err(`! ${w}\n`));
        if (parsed.servers.length !== 1) { io.err(parsed.servers.length ? 'That text has several servers: add them one at a time, or use kora ext import.\n' : usage + '\n'); return 2; }
        const s = parsed.servers[0]!;
        const env = { ...(s.env ?? {}), ...Object.fromEntries(values('--env').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; })) };
        const headers = { ...(s.headers ?? {}), ...Object.fromEntries(values('--header').map((h) => { const i = h.indexOf(':'); return [h.slice(0, i).trim(), h.slice(i + 1).trim()]; })) };
        const secrets: Record<string, string> = {};
        // Credential-looking literals from the snippet go to the keychain, not the file.
        for (const slot of parsed.secretKeys[s.name] ?? []) {
          const [kind, key] = [slot.slice(0, slot.indexOf(':')), slot.slice(slot.indexOf(':') + 1)];
          const v = (kind === 'env' ? env[key] : headers[key]) as string | undefined;
          if (typeof v === 'string') { secrets[slot] = v; if (kind === 'env') delete env[key]; else delete headers[key]; }
        }
        for (const key of values('--secret')) {
          const v = (await readStdin()).trim();
          if (!v) { io.err(`--secret ${key}: pipe the value on stdin (e.g. pbpaste | kora ext add …)\n`); return 2; }
          secrets[`env:${key}`] = v;
        }
        input = { server: { ...s, ...common, source: 'manual', ...(Object.keys(env).length ? { env } : {}), ...(Object.keys(headers).length ? { headers } : {}) }, secrets };
      }
      const saved = await ext.saveServer(input);
      io.out(`✓ added ${saved.name} for ${saved.agents.join(', ')}${saved.workers ? ' (and workers)' : ''}. Testing…\n`);
      const h = await ext.test(saved.name);
      io.out(h.ok ? `✓ ${saved.name} answers: ${h.tools.length} tool(s)${h.tools.length ? `: ${h.tools.slice(0, 8).join(', ')}${h.tools.length > 8 ? ', …' : ''}` : ''}\n` : `✗ ${saved.name} did not start: ${h.error}${h.stderr ? `\n${h.stderr}` : ''}\n`);
      io.out('New chats and workers pick it up; running ones keep what they started with.\n');
      return 0;
    }
    if (verb === 'remove') { const ok = await ext.deleteServer(rest[0] ?? ''); io.out(ok ? `✓ removed ${rest[0]}\n` : `no extension named ${rest[0]}\n`); return ok ? 0 : 1; }
    if (verb === 'enable' || verb === 'disable') { const s = ext.enableServer(rest[0] ?? '', verb === 'enable'); io.out(`✓ ${s.name} ${verb}d\n`); return 0; }
    if (verb === 'test') {
      const h = await ext.test(rest[0] ?? '', { cwd: process.cwd() });
      io.out(h.ok ? `✓ ${rest[0]}: ${h.tools.length} tool(s) in ${h.ms} ms${h.serverName ? ` (${h.serverName} ${h.serverVersion ?? ''})` : ''}\n  ${h.tools.join('\n  ')}\n` : `✗ ${rest[0]}: ${h.error}${h.stderr ? `\n${h.stderr}` : ''}\n`);
      return h.ok ? 0 : 1;
    }
    if (verb === 'import') {
      const found = ext.discover().filter((g) => !g.alreadyAdded);
      if (!found.length) { io.out('Nothing new to import: Kora already has every server your agents are configured with.\n'); return 0; }
      for (const g of found) io.out(`  ${g.server.name.padEnd(22)} from ${g.agents.join(', ')}${g.folders.length ? ` (only in ${g.folders.join(', ')})` : ''}\n`);
      if (!flag('--yes')) { io.out('Run again with --yes to add these for every agent.\n'); return 0; }
      for (const g of found) {
        const parsed = ext.parseInput(JSON.stringify({ mcpServers: { [g.server.name]: g.server.transport === 'http' ? { url: g.server.url, headers: g.server.headers } : { command: g.server.command, args: g.server.args, env: g.server.env } } }));
        const secrets: Record<string, string> = {};
        const s = { ...g.server, env: { ...(g.server.env ?? {}) }, headers: { ...(g.server.headers ?? {}) } };
        for (const slot of parsed.secretKeys[g.server.name] ?? []) {
          const i = slot.indexOf(':'); const kind = slot.slice(0, i); const key = slot.slice(i + 1);
          const v = kind === 'env' ? s.env[key] : s.headers[key];
          if (typeof v === 'string') { secrets[slot] = v; if (kind === 'env') delete s.env[key]; else delete s.headers[key]; }
        }
        await ext.saveServer({ server: { ...s, source: `import:${g.agents[0]}`, ...(g.folders.length ? { folders: g.folders } : {}) }, secrets });
        io.out(`✓ ${g.server.name}\n`);
      }
      return 0;
    }
    if (verb === 'project') {
      const r = ext.projectServers(process.cwd());
      if (!r.root) { io.out('No .kora/extensions.json in this repository.\n'); return 0; }
      const allow = one('--allow'); const revoke = one('--revoke');
      if (allow || revoke) { ext.setProjectServerApproved(process.cwd(), (allow ?? revoke)!, !!allow); io.out(`✓ ${allow ? 'allowed' : 'revoked'} ${allow ?? revoke}\n`); return 0; }
      for (const p of r.servers) io.out(`${p.approved ? '✓ allowed' : '· waiting'}  ${p.server.name.padEnd(20)} ${p.server.transport === 'http' ? p.server.url : [p.server.command, ...(p.server.args ?? [])].join(' ')}${p.missingSecrets.length ? `  (needs: ${p.missingSecrets.join(', ')})` : ''}\n`);
      return 0;
    }
    if (verb === 'secret' && rest[1] === 'set' && rest[2]) {
      const v = (await readStdin()).trim();
      if (!v) { io.err('Pipe the value on stdin.\n'); return 2; }
      await ext.saveProjectSecret(rest[2], v);
      io.out(`✓ saved ${rest[2]} in the keychain\n`);
      return 0;
    }
    if (verb === 'skill') {
      const [sub, target] = rest;
      if (sub === 'add' && target) {
        const r = await ext.installSkills(target, agentsOpt() ? { agents: agentsOpt()! } : {});
        for (const k of r.installed) io.out(`✓ skill ${k.name}: ${k.description || '(no description)'}\n`);
        for (const k of r.skipped) io.out(`! skipped ${k.name}: ${k.reason}\n`);
        return r.installed.length ? 0 : 1;
      }
      if (sub === 'remove' && target) { const ok = ext.removeSkill(target); io.out(ok ? `✓ removed skill ${target}\n` : `no skill named ${target}\n`); return ok ? 0 : 1; }
      for (const k of ext.loadExtensions().skills) io.out(`${k.name.padEnd(24)} ${k.description}\n`);
      return 0;
    }
    io.err(usage + '\n');
    return 2;
  } catch (e: any) {
    io.err(`kora ext: ${e?.message ?? e}\n`);
    return 1;
  }
}

/**
 * `kora ext exec <name>`: start a stdio server with its secret env read here (an agent that would otherwise need the
 * values on its own command line starts this instead). stdin/stdout pass straight through; the exit code is the server's.
 */
async function execServer(name: string | undefined, io: IO): Promise<number> {
  const ext = require('../../extensions') as typeof import('../../extensions');
  const s = ext.loadExtensions().mcpServers.find((e) => e.name === name);
  if (!s || s.transport !== 'stdio' || !s.command) { io.err(`kora ext exec: no local server named ${name}\n`); return 2; }
  const { warmSecrets, cachedSecret } = require('../../extensions/store') as typeof import('../../extensions/store');
  await warmSecrets([s]);
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [k, v] of Object.entries(s.env ?? {})) {
    const value = ext.isSecretRef(v) ? cachedSecret(v.secret) : v;
    if (value === null) { io.err(`kora ext exec: ${name}: the saved value for ${k} is missing; re-add it in Settings › Extensions\n`); return 1; }
    env[k] = value;
  }
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  return await new Promise<number>((resolve) => {
    const child = spawn(s.command!, s.args ?? [], { stdio: 'inherit', env });
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    process.on('SIGTERM', forward('SIGTERM'));
    process.on('SIGINT', forward('SIGINT'));
    child.on('error', (e) => { io.err(`kora ext exec: ${name}: ${e.message}\n`); resolve(127); });
    child.on('exit', (code, sig) => resolve(code ?? (sig ? 1 : 0)));
  });
}
