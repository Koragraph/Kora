import type {
  HostId,
  ThreadMessage,
  ChatProjectHead,
  ChatThread,
  ChatThreadHead,
} from "@kora/contracts";

export interface HostProject extends ChatProjectHead {
  readonly hostId: HostId;
}

export interface HostThreadShell extends ChatThreadHead {
  readonly hostId: HostId;
}

export type HostMessage = ThreadMessage;

export interface HostThread extends ChatThread {
  readonly hostId: HostId;
}

export function scopeProject(hostId: HostId, project: ChatProjectHead): HostProject {
  return { ...project, hostId };
}

export function scopeThreadSummary(hostId: HostId, thread: ChatThreadHead): HostThreadShell {
  return { ...thread, hostId };
}

export function scopeThread(hostId: HostId, thread: ChatThread): HostThread {
  return { ...thread, hostId };
}
