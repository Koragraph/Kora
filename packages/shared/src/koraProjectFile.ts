import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { KoraProjectFile } from "@kora/contracts";

import { parseLenientJson } from "./lenientJson.ts";

/**
 * Codec between the raw `kora.json` file contents (lenient JSONC string) and the
 * decoded {@link KoraProjectFile}.
 */
export const KoraProjectFileFromJson = parseLenientJson(KoraProjectFile);

const decodeKoraProjectFile = Schema.decodeExit(KoraProjectFileFromJson);

/**
 * Decode raw `kora.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseKoraProjectFile(contents: string): KoraProjectFile | null {
  const decoded = decodeKoraProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}
