# Getting help

- **How do I…?** Start with the [README](README.md) and the [docs](docs/README.md). For anything they do not answer,
  ask in [Discussions](https://github.com/Koragraph/Kora/discussions).
- **Something is broken.** Open a [bug report](https://github.com/Koragraph/Kora/issues/new?template=bug_report.yml)
  with a diagnostics bundle (Settings › Diagnostics › Export diagnostics, or `kora doctor --export`; it is redacted).
- **Something is wrong with an agent itself** (a login, a model, a rate limit): check the agent's own status page and
  docs first; Kora uses each agent as it is.
- **Security**: see [SECURITY.md](SECURITY.md).

## First checks

| Symptom                                               | Try                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| The app shows "Waiting for Kora's background service" | `kora server status`; then `kora server stop && kora server start` |
| Port 8797 is in use                                   | `lsof -i :8797` and stop what holds it, then reopen Kora           |
| `kora: command not found`                             | add `~/.local/bin` to your PATH                                    |
| The code graph chip says Incomplete or Stale          | Re-index from the chip, or `kora ingest . --full`                  |
| An MCP server does not show up in an agent            | Settings › Extensions › Test, and check the agent is ticked for it |
| Anything else                                         | `kora doctor` names a fix for every check that fails               |
