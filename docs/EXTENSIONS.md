# Extensions: MCP servers and skills

Add an MCP server or a skill once, and Claude Code, Codex, OpenCode and Antigravity all get it, each in its own format.
Everything here works from **Settings › Extensions** or from a terminal with `kora ext`.

## Add a server

**Paste whatever the server's README shows.** Kora reads all the common shapes:

```jsonc
// Claude Code, Cursor, Antigravity, Gemini CLI
{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "…" } } } }
// VS Code
{ "servers": { "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] } } }
// OpenCode
{ "mcp": { "pw": { "type": "local", "command": ["npx", "-y", "@playwright/mcp@latest"] } } }
```

```toml
# Codex
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
```

```sh
npx -y @modelcontextprotocol/server-memory                        # a command
https://mcp.example.com/mcp                                        # a remote server
claude mcp add -e API_KEY=… ctx -- npx -y @upstash/context7-mcp    # another agent's add command
```

Kora shows what it understood before saving: the name, the command or URL, the environment variables or headers, and
which agents get it. Values that look like credentials (tokens, keys, passwords, `Authorization`) are marked secret
automatically. **Test** starts the server the way an agent would and lists its tools, or shows the error and the last
lines it printed.

From a terminal:

```sh
kora ext add memory -- npx -y @modelcontextprotocol/server-memory
kora ext add docs https://mcp.example.com/mcp --header "X-Team: core"
pbpaste | kora ext add --paste                 # a README snippet from the clipboard
kora ext add notion --secret NOTION_TOKEN -- npx -y @notionhq/notion-mcp-server < token.txt
kora ext test memory
kora ext list
```

## Import what your agents already have

Settings › Extensions lists the servers already configured in each agent's own settings (`~/.claude.json`,
`~/.codex/config.toml`, `~/.config/opencode/opencode.json`, `~/.gemini/config/mcp_config.json`). Import one and every
agent gets it. `kora ext import` lists them; `kora ext import --yes` imports them all. Kora only reads those files here.

## The catalog

A short list of servers checked against their maintainers' published packages: GitHub, Context7, Playwright, Chrome
DevTools, Filesystem, Fetch, Git, Memory, Sequential thinking, Notion, Sentry, Supabase. Each one asks only for what it
needs (a token, a folder). `kora ext catalog` lists them; `kora ext add --catalog github --set Authorization=…` adds one.

## Who gets what

Each server has:

- **Agents**: any of the four (all by default).
- **Also for worker panes**: off by default. A worker should get only what its task needs, and every server's tool
  list is re-read on every call.
- **Folders** (CLI `--folder`): only sessions inside these folders.

How each agent receives it:

| Agent       | Delivery                                                                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | passed to each session at launch (the Agent SDK's `mcpServers`; a per-pane `--mcp-config` file for CLI panes)                                                                                                                                            |
| Codex       | passed to each turn as `-c mcp_servers.<name>…`; secret values travel in environment variables, never on the command line                                                                                                                                |
| OpenCode    | passed to each run in its configuration                                                                                                                                                                                                                  |
| Antigravity | kept in Antigravity's own `~/.gemini/config/mcp_config.json`, because `agy` has no per-launch option. Kora only adds, updates and removes entries it wrote itself; an entry of yours with the same name is left alone. Folder limits do not apply there. |

New chats and workers pick a change up; a running session keeps what it started with.

## Secrets

A value marked secret goes to the macOS Keychain and the extensions file keeps only a reference. Secret values are
never sent to the app's window and never written to the agent's command line. For a Codex server with secret
environment variables, Codex starts `kora ext exec <name>`, which reads the values itself and then runs the server.

## Share servers with a repository

Commit `.kora/extensions.json` to a repository:

```json
{
  "mcpServers": [
    {
      "name": "team-db",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@acme/db-mcp"],
      "env": { "DB_URL": { "secret": "team-db-url" } }
    }
  ]
}
```

A teammate sees these under **Shared by your projects** and nothing runs until they **Allow** each server. The
approval covers that exact definition: if a commit (or an agent) changes the command, it needs allowing again.
Project servers load only in folders you trust in Kora, and a server of yours with the same name wins.

## Skills

A skill is a folder with a `SKILL.md` (YAML front matter `name` and `description`, then instructions). Install one from
a folder or a git repository; a repository with several skills (`skills/*/SKILL.md`) installs each:

```sh
kora ext skill add ~/skills/release-notes
kora ext skill add https://github.com/owner/skills
kora ext skill list
kora ext skill remove release-notes
```

Kora keeps its copy in `~/.kora/extensions/skills/` and links it into each agent's skills folder (`~/.claude/skills`,
`~/.codex/skills`, `~/.config/opencode/skill`, `~/.gemini/antigravity/skills`). A skill of yours with the same name is
never replaced, and removing a skill removes only Kora's links.

## Safety

- Agents cannot add, change or remove extensions: `kora ext add|remove|enable|disable|import --yes|skill` refuse to run
  from an agent's shell, and the extensions file and skills folder are write-protected from agents.
- Repository-shared servers need your approval per definition, in trusted folders only.
- Plain `http://` is accepted only for `localhost`.

## Where it lives

`packages/runtime/src/extensions/` (store, parsing, per-agent wiring, catalog, skills, the Antigravity sync),
`packages/runtime/src/cli/commands/ext.ts`, the `extensions.*` RPCs in `packages/contracts/src/extensions.ts`, and the
settings page in `apps/web/src/components/settings/extensions/`.
