// A blob's permission (Ask / Auto / Full) as the access mode its thread runs in - the client twin of the runtime's
// `resolveBlobRuntimeMode` (packages/runtime/src/blobs/permissions.ts). The daemon owns the truth (it forces this posture
// on every blob thread it creates); the client uses it so a blob's composer shows the real mode before the thread
// exists instead of the app-wide default ("Full access").
import type { AccessMode, BlobPermission } from "@kora/contracts";

export function blobAccessMode(permission: BlobPermission, instanceId: string): AccessMode {
  if (permission === "full") return "full-access";
  if (permission === "ask") return "approval-required";
  const claude =
    (instanceId.split(":")[0] ?? instanceId) === "claude" ||
    /^claude-[a-z0-9][a-z0-9-]*$/.test(instanceId);
  return claude ? "auto" : "auto-accept-edits";
}
