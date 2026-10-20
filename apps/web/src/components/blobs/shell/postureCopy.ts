// The three postures of a blob, under the names the Blobs surface uses everywhere (editor, composer, settings):
// Ask / Auto / Full. Code-surface names ("Default", "Accept edits", "Full access", "bypass permissions") never show up here.
import type { AccessMode, BlobPermission } from "@kora/contracts";

export interface PostureCopy {
  readonly id: BlobPermission;
  readonly label: string;
  readonly body: string;
  readonly danger?: boolean;
}

export const POSTURES: ReadonlyArray<PostureCopy> = [
  {
    id: "ask",
    label: "Ask",
    body: "Checks with you before every command, every edit and anything outside its folder.",
  },
  {
    id: "auto",
    label: "Auto",
    body: "Works freely with plain file commands in its own folder and in its browser. Asks for other shell commands, before leaving them, and before anything that sends, posts, deletes, pays or signs in.",
  },
  {
    id: "full",
    label: "Full",
    body: "No questions, even for outbound actions. Only for a blob you trust completely.",
    danger: true,
  },
];

export const postureCopy = (id: BlobPermission): PostureCopy =>
  POSTURES.find((p) => p.id === id) ?? POSTURES[1]!;

/** The thread access mode each posture runs in on this engine (twin of the runtime's resolveBlobRuntimeMode). */
export function postureAccessMode(id: BlobPermission, driverKind: string | undefined): AccessMode {
  if (id === "full") return "full-access";
  if (id === "ask") return "approval-required";
  return driverKind === "claude" || driverKind === undefined ? "auto" : "auto-accept-edits";
}

export function postureOfAccessMode(mode: AccessMode): BlobPermission {
  return mode === "full-access" ? "full" : mode === "approval-required" ? "ask" : "auto";
}
