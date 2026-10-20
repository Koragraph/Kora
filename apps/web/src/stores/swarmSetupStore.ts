import type { HostThreadRef } from "@kora/contracts";
import { create } from "zustand";

import type { DraftId } from "./promptDraftStore";

/**
 * The Swarm setup dialog's open state (not persisted). `pendingSwitch` is the thread or draft that
 * asked for Swarm while setup was incomplete: the dialog commits the switch only on "Start Swarm";
 * closing it early changes nothing and sends no notice.
 */
export type SwarmSetupStep = "intro" | "opencode" | "providers" | "ready";

interface SwarmSetupState {
  readonly open: boolean;
  /** "quick" = the one-sheet first-time setup (one button does consent, OpenCode and a free default); "wizard" = the
   *  step-by-step setup with keys and local models (Settings → Swarm, provider banners). */
  readonly variant: "quick" | "wizard";
  readonly step: SwarmSetupStep;
  readonly pendingSwitch: { readonly target: HostThreadRef | DraftId } | null;
}

const CLOSED: SwarmSetupState = {
  open: false,
  variant: "wizard",
  step: "intro",
  pendingSwitch: null,
};

export const useSwarmSetupStore = create<SwarmSetupState>()(() => CLOSED);

export function openSwarmSetup(opts?: {
  readonly step?: SwarmSetupStep;
  readonly pendingSwitch?: { readonly target: HostThreadRef | DraftId } | null;
}): void {
  useSwarmSetupStore.setState({
    open: true,
    variant: "wizard",
    step: opts?.step ?? "intro",
    pendingSwitch: opts?.pendingSwitch ?? null,
  });
}

/** The first time Swarm is turned on (or set up from a banner): one sheet, one button. */
export function openSwarmQuickSetup(opts?: {
  readonly pendingSwitch?: { readonly target: HostThreadRef | DraftId } | null;
}): void {
  useSwarmSetupStore.setState({
    open: true,
    variant: "quick",
    step: "intro",
    pendingSwitch: opts?.pendingSwitch ?? null,
  });
}

export function closeSwarmSetup(): void {
  // Only `open` flips: the variant and step stay until the next open, so the dialog does not swap its content
  // while it plays its exit transition (a swapped popup never finishes closing and the dialog looks stuck open).
  useSwarmSetupStore.setState({ open: false });
}
