import type { AccessMode } from "@kora/contracts";

export const accessModeConfig: Record<
  AccessMode,
  { label: string; description: string; danger?: boolean }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Nothing runs until you say go — every command, every edit.",
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Edits happen automatically. Commands still stop and ask.",
  },
  auto: {
    label: "Auto",
    description: "Routine work runs itself; anything risky still comes to you.",
  },
  "full-access": {
    label: "Full access",
    description: "No prompts, no pauses — commands and edits run instantly.",
    danger: true,
  },
};

export const accessModeOptions = Object.keys(accessModeConfig) as AccessMode[];
