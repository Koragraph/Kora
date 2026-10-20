import type { HostId, HostDescriptor } from "@kora/contracts";

export interface KnownHostLinkTarget {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export type KnownHostSource = "configured" | "desktop-managed" | "manual" | "window-origin";

export interface KnownHost {
  readonly id: string;
  readonly label: string;
  readonly source: KnownHostSource;
  readonly hostId?: HostId;
  readonly target: KnownHostLinkTarget;
}

export function createKnownHost(input: {
  readonly id?: string;
  readonly label: string;
  readonly source?: KnownHostSource;
  readonly target: KnownHostLinkTarget;
}): KnownHost {
  return {
    target: input.target,
    source: input.source ?? "manual",
    label: input.label,
    id: input.id ?? "ws:" + input.label,
  };
}

export function attachHostDescriptor(
  environment: KnownHost,
  descriptor: HostDescriptor,
): KnownHost {
  return {
    ...environment,
    hostId: descriptor.hostId,
    label: descriptor.label,
  };
}
