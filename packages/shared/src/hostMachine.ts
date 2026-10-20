import * as Context from "effect/Context";

export const MachinePlatform = Context.Reference<NodeJS.Platform>(
  "@kora/shared/hostMachine/MachinePlatform",
  {
    defaultValue: () => process.platform,
  },
);

export const MachineArchitecture = Context.Reference<NodeJS.Architecture>(
  "@kora/shared/hostMachine/MachineArchitecture",
  {
    defaultValue: () => process.arch,
  },
);

export const MachineEnv = Context.Reference<NodeJS.ProcessEnv>(
  "@kora/shared/hostMachine/MachineEnv",
  {
    defaultValue: () => process.env,
  },
);

/**
 * The command the shell was given, before Node resolved it to the binary:
 * `kora` for a PATH lookup, `./kora` or the launcher symlink for an explicit
 * path. `process.argv[0]` and `execPath` are always the resolved binary.
 */

/**
 * Whether this process is a Node single-executable rather than a script run
 * by a Node on the machine. Code that needs a sibling file or a Node to run
 * one branches on this: an executable hosts such things as hidden
 * subcommands of itself.
 */

/**
 * Every IP address this machine answers to: the interface addresses, plus
 * whatever the resolver returns for the machine's own hostname. The latter
 * matters because a hostname can map to an address no interface carries —
 * Debian-style hosts put `127.0.1.1` in `/etc/hosts` — and a program that
 * records "its" address by resolving its hostname (Firefox's profile lock
 * does) will write that one. "Is this address ours" has to accept both.
 *
 * Best effort: a failed lookup just leaves the interface set.
 */

/** Undefined on platforms without POSIX uids (Windows). */
export const MachineUserId = Context.Reference<number | undefined>(
  "@kora/shared/hostMachine/MachineUserId",
  {
    defaultValue: () => process.getuid?.(),
  },
);
