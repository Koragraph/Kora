import {
  type HostThreadRef,
  type HostProjectRef,
  type ProjectId as ProjectIdType,
  type HostId as HostIdType,
  ThreadId,
  HostId,
} from "@kora/contracts";

export function hostProjectRef(hostId: HostIdType, projectId: ProjectIdType): HostProjectRef {
  return { hostId, projectId };
}

export function hostThreadRef(hostId: HostIdType, threadId: ThreadId): HostThreadRef {
  return { hostId, threadId };
}

function scopedRefKey(ref: HostProjectRef | HostThreadRef): string {
  const localId = "projectId" in ref ? ref.projectId : ref.threadId;
  return `${ref.hostId}:${localId}`;
}

export const hostProjectKey = (ref: HostProjectRef): string => scopedRefKey(ref);

export const hostThreadKey = (ref: HostThreadRef): string => scopedRefKey(ref);

function parseScopedKey(key: string): { hostId: HostIdType; localId: string } | null {
  const colon = key.indexOf(":");
  const interior = colon > 0 && colon < key.length - 1;
  return interior
    ? { localId: key.slice(colon + 1), hostId: HostId.make(key.slice(0, colon)) }
    : null;
}

export function parseHostThreadKey(key: string): HostThreadRef | null {
  const parsed = parseScopedKey(key);
  return parsed && { threadId: ThreadId.make(parsed.localId), hostId: parsed.hostId };
}
