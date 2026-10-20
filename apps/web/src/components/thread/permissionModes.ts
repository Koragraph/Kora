import type { AgentId, AccessMode } from "@kora/contracts";
import { accessModeConfig, accessModeOptions } from "./accessModeConfig";
import { POSTURES, postureAccessMode, postureOfAccessMode } from "../blobs/shell/postureCopy";

export interface PermissionOption {
  mode: AccessMode;
  label: string;
  description: string;
  danger?: boolean;
}

/**
 * The permission levels a harness actually has, under that harness's own names. Kora keeps one
 * AccessMode per thread (workers inherit it, never above it); each CLI maps it to its own flags
 * (claude-driver toSdkPermissionMode, codex-driver codexPermissionArgs, antigravity-driver agyPermissionArgs).
 */
export function permissionOptionsFor(
  driverKind: AgentId | undefined,
  o: { blob?: boolean } = {},
): PermissionOption[] {
  // A blob's composer: Ask / Auto / Full, whatever the engine calls its own levels.
  if (o.blob) {
    return POSTURES.map((p) => ({
      mode: postureAccessMode(p.id, driverKind),
      label: p.label,
      description: p.body,
      ...(p.danger ? { danger: true } : {}),
    }));
  }
  if (driverKind === "claude") {
    return [
      {
        mode: "approval-required",
        label: "Default",
        description: "Asks before every edit and command.",
      },
      {
        mode: "auto-accept-edits",
        label: "Accept edits",
        description: "Edits apply automatically; commands still ask.",
      },
      {
        mode: "auto",
        label: "Auto",
        description: "Routine work runs itself; anything risky still asks.",
      },
      {
        mode: "full-access",
        label: "Full access",
        description:
          "No prompts — edits and commands run instantly (Claude Code’s “bypass permissions”).",
        danger: true,
      },
    ];
  }
  if (driverKind === "codex") {
    // Codex exec cannot ask for approval, so each level is a sandbox (approval_policy=never).
    return [
      {
        mode: "approval-required",
        label: "Read only",
        description: "Sandbox read-only: Codex can look but not change anything.",
      },
      {
        mode: "auto-accept-edits",
        label: "Workspace write",
        description: "Sandbox workspace-write: edits inside this project only.",
      },
      {
        mode: "full-access",
        label: "Full access",
        description: "danger-full-access: no sandbox, no approvals.",
        danger: true,
      },
    ];
  }
  if (driverKind === "antigravity") {
    // `agy` print mode cannot ask: a tool the level does not cover is skipped (never a prompt that would hang the turn).
    return [
      {
        mode: "approval-required",
        label: "Read only",
        description:
          "Antigravity reads and answers; edits and commands are skipped (it cannot ask here).",
      },
      {
        mode: "auto-accept-edits",
        label: "Accept edits",
        description: "Edits apply automatically; shell commands are skipped (it cannot ask here).",
      },
      {
        mode: "full-access",
        label: "Full access",
        description: "Edits and commands run without asking (agy --dangerously-skip-permissions).",
        danger: true,
      },
    ];
  }
  return accessModeOptions.map((mode) => ({ mode, ...accessModeConfig[mode] }));
}

/** The option a mode shows as on this harness (Codex and Antigravity run `auto` exactly like full access). */
export function permissionOptionFor(
  driverKind: AgentId | undefined,
  mode: AccessMode,
  o: { blob?: boolean } = {},
): PermissionOption {
  const options = permissionOptionsFor(driverKind, o);
  if (o.blob) {
    // Accept-edits / auto are one "Auto" for a blob on any engine.
    const want = postureAccessMode(postureOfAccessMode(mode), driverKind);
    return options.find((x) => x.mode === want) ?? options[0]!;
  }
  const effective =
    (driverKind === "codex" || driverKind === "antigravity") && mode === "auto"
      ? "full-access"
      : mode;
  return options.find((x) => x.mode === effective) ?? options[0]!;
}
