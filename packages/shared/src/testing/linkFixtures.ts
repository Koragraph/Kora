// @effect-diagnostics nodeBuiltinImport:off - one synchronous probe at module load, outside any Effect runtime.

/**
 * Whether this host lets an unprivileged process create symlinks. Windows
 * refuses without Developer Mode or elevation, so tests that plant a symlink
 * to prove containment or escape detection should `skipIf(!symlinksSupported)`
 * rather than fail at setup. Probed once per process.
 */
