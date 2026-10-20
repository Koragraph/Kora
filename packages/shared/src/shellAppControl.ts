import { sha256 } from "@noble/hashes/sha2";

export interface ShellAppControlAddress {
  readonly directory: string | null;
  readonly address: string;
}

function shortHash(value: string): string {
  const digest = sha256(new TextEncoder().encode(value));
  let hex = "";
  for (const byte of digest.subarray(0, 12)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Returns the local-only socket address shared by the desktop shell and CLI.
 * The state directory is hashed so custom Kora homes cannot exceed Unix socket
 * path limits.
 */
export function resolveShellAppControlAddress(input: {
  readonly joinPath: (...segments: readonly string[]) => string;
  readonly userId: number | undefined;
  readonly tempDir: string;
  readonly platform: NodeJS.Platform;
  readonly stateDir: string;
}): ShellAppControlAddress {
  const stateHash = shortHash(input.stateDir);
  if (input.platform === "win32") {
    return { directory: null, address: "\\\\.\\pipe\\kora-app-" + stateHash };
  }

  const userKey = input.userId ?? stateHash.slice(0, 12);
  const directory = input.joinPath(input.tempDir, "kora-" + userKey);
  return { directory, address: input.joinPath(directory, stateHash + ".sock") };
}
