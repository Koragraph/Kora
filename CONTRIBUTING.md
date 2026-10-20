# Contributing to Kora

Thanks for taking the time. Kora is a desktop app that runs coding agents as an orchestrated fleet; contributions of
every size are welcome, from a typo to a new agent integration.

## Before you start

- **Bugs**: open an issue with the bug form. A diagnostics bundle (Settings › Diagnostics › Export diagnostics, or
  `kora doctor --export`) is redacted and saves a lot of back and forth.
- **Features**: open a discussion or an issue first for anything bigger than a small fix, so we can agree on the shape
  before you spend time on it.
- **Security issues**: never in a public issue. See [SECURITY.md](SECURITY.md).

## Setting up

You need macOS on Apple Silicon, Node 24 (`^24.11.1`), pnpm 11 and the Xcode command line tools.

```sh
git clone https://github.com/Koragraph/Kora.git && cd Kora
pnpm install
pnpm build
pnpm dev          # the app with the web client hot-reloading
```

The app talks to a background daemon (`kora server run`). Runtime and UI-server changes need a daemon restart:
`kora server stop && kora server start`. `pnpm dev` uses the default daemon port (8797); if you also run the released
Kora, quit it first, or work in an isolated stack with its own home, socket and ports:
`KORA_QA_DIR=$(mktemp -d) node qa/stacks/stack.cjs up 1` (see `qa/README.md`).

[AGENTS.md](AGENTS.md) is the short guide to the repository: the layout, the commands, and the handful of rules that
cost real time when broken (wire values, the daemon's event loop, folder trust, native modules). Read it first.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the processes and packages fit together.

## Making a change

1. Fork, then branch from `main`.
2. Keep the change focused: one fix or one feature per pull request.
3. Add or update tests for behaviour you change. Each package has its own suite:
   - `apps/web`, `apps/desktop`, `packages/client-runtime`, `packages/contracts`, `packages/shared`: `pnpm --filter <pkg> test` (Vitest)
   - `packages/ui-server`, `packages/runtime`: `pnpm --filter <pkg> test` (Node's test runner; the runtime suite needs macOS)
   - UI flows: `pnpm qa` runs the Playwright suite against isolated daemons (see `qa/README.md`)
4. Before you push:

   ```sh
   pnpm typecheck && pnpm lint && pnpm fmt:check && pnpm test
   ```

5. Open a pull request using the template. Describe what changed and how you verified it; screenshots for UI changes.

## Style

- TypeScript everywhere. The formatter (`pnpm fmt`) and linter (`pnpm lint`) are the source of truth for style.
- Write the least code that works, and match the code around it: naming, comment density, idioms.
- Comments explain why, not what.
- The UI is dark, flat and monochrome. `apps/web/src/designTokens.test.ts` fails on a new hue or on text below WCAG AA.
- User-facing text is plain and specific: say what happened and what to do next.

## Commit messages

A short summary line in the imperative or descriptive mood, then a blank line and a body that explains why when it is
not obvious. Reference issues with `Fixes #123`.

## Developer Certificate of Origin

By contributing you certify that you wrote the contribution or otherwise have the right to submit it under the
project's license, as described in the [Developer Certificate of Origin](https://developercertificate.org/). Sign off
each commit with `git commit -s`.

## License

Contributions are licensed under the [MIT License](LICENSE).
