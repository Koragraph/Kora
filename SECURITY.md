# Security policy

Kora runs coding agents on your machine with access to your code, so security reports get priority.

## Reporting a vulnerability

Please report privately through GitHub: **[Report a vulnerability](https://github.com/Koragraph/Kora/security/advisories/new)**.
Do not open a public issue or discussion.

Include what you found, how to reproduce it, and what an attacker could do with it. You will get an acknowledgement
within three working days and a plan within ten. Once a fix ships, the advisory is published with credit to you unless
you prefer otherwise.

## Supported versions

The latest release is supported. Kora updates itself, so fixes ship as a new release rather than as patches to old
ones.

## In scope

- The `kora` daemon and CLI: the local socket and UI API, authentication between the app and the daemon, folder trust,
  the write fences around Kora's own files, the extensions store and its secrets.
- The desktop app: the `kora://` protocol, the content security policy, IPC between the window and the main process.
- Anything that lets an agent, a repository's files, or a web page escalate beyond what the user allowed: running a
  folder's agent configuration without trust, an agent changing Kora's settings or extensions, reading secrets.

## Out of scope

- Vulnerabilities in the agents themselves (Claude Code, Codex, OpenCode, Antigravity) or their providers: report
  those to their vendors.
- Anything that needs an attacker who already runs code as your user.
- What an agent does with permissions you granted it (for example Full access in a folder you trust).

## Hardening notes

- The UI API listens on loopback only and requires a bearer token stored in `~/.kora/ui-token` (0600); the app checks
  that the daemon holds that token before sending it.
- Secrets (API keys, extension values) are kept in the macOS Keychain.
- Agents cannot run the CLI commands that change trust, configuration or extensions, and Kora's control files are
  write-protected from agent tools.
