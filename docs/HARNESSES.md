# Agents in Kora

Kora drives four coding agents with their own logins and subscriptions: **Claude Code**, **Codex**, **OpenCode** and
**Antigravity**. It never sees your credentials; each agent signs in the way it always does. One working agent is
enough; set up the others in Settings › Agents.

## At a glance

|                                                | Claude Code                                                                                      | Codex                                                                       | OpenCode                                                                                                                   | Antigravity                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Sign in                                        | one click on Kora's first screen, or `claude auth login`                                         | `codex login`                                                               | `opencode auth login` (free models need no key)                                                                            | `agy`                                                           |
| How Kora runs it                               | Claude Agent SDK, one live session per thread                                                    | `codex exec --json`, one process per turn                                   | `opencode run --format json`, one process per turn                                                                         | `agy --print --output-format=stream-json`, one process per turn |
| Lead a fleet                                   | ✓ (in-process fleet tools)                                                                       | ✓ (fleet tools over MCP)                                                    | ✓ (fleet tools over MCP)                                                                                                   | —                                                               |
| Worker                                         | ✓                                                                                                | ✓                                                                           | ✓ (also the free Stretch tier)                                                                                             | ✓                                                               |
| Asks you before acting                         | ✓ (approval cards)                                                                               | — (Supervised runs in a read-only sandbox)                                  | — (Supervised can read and search, not edit)                                                                               | — (choose Read only, Accept edits or Full access)               |
| Plan mode                                      | its own                                                                                          | read-only sandbox for the plan turn                                         | its own                                                                                                                    | its own                                                         |
| Code graph                                     | declarations injected per prompt; rulebook in `CLAUDE.md`; search redirect and read dedupe hooks | declarations injected per prompt; rulebook and session brief in `AGENTS.md` | declarations injected per prompt; rulebook in `AGENTS.md`; Stretch workers also get a graph context packet with their task | declarations injected per prompt; rulebook in `AGENTS.md`       |
| Your MCP servers ([Extensions](EXTENSIONS.md)) | passed at launch                                                                                 | passed at launch (`-c mcp_servers…`)                                        | passed at launch (config)                                                                                                  | kept in Antigravity's own `~/.gemini/config/mcp_config.json`    |
| Your skills                                    | `~/.claude/skills`                                                                               | `~/.codex/skills`                                                           | `~/.config/opencode/skill`                                                                                                 | `~/.gemini/antigravity/skills`                                  |
| Plan usage meter                               | ✓                                                                                                | ✓                                                                           | —                                                                                                                          | ✓                                                               |
| Several accounts                               | ✓ (named logins, each in its own folder)                                                         | one                                                                         | per provider                                                                                                               | one                                                             |

## Permissions

The composer's model picker shows each agent's own permission modes under its own names. Kora adds one rule on top:
**folder trust**. Until you trust a folder, an agent runs there without the repository's own agent configuration
(Claude Code project hooks and MCP servers, Codex project config, OpenCode plugins), and Kora never answers an agent's
"trust this folder?" prompt for you. Trust a folder from the project menu or Settings › Projects.

Worker panes follow your default worker permission (Settings › Agents). A stopped worker stays stopped.

## What Kora writes where

Kora keeps its own state in `~/.kora` and the code graph in `~/.koragraph`. In a project you open, it adds a managed
block to `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` between `<!-- kora:begin -->` and `<!-- kora:end -->` (your own text
outside the markers is never touched) and Claude Code hooks to `.claude/settings.local.json`, which git ignores through
`.git/info/exclude`. In an untrusted folder it writes nothing; the rulebook rides in the system prompt instead.
`kora enforce uninstall` removes everything it added to a repo; `kora uninstall` removes it from the machine.

## Other agents

Kora also recognises many other agent CLIs in terminal panes (Gemini CLI, Cursor, GitHub Copilot, Amp, Kimi, Qwen and
more) and can run any Agent Client Protocol (ACP) agent or an OpenAI-compatible API endpoint as an engine
(Settings › Engines). Those get the code graph through their instruction files and the CLI; the fleet roles above are
for the four agents in the table.
