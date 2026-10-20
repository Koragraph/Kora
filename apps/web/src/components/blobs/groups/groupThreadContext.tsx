// What the transcript and the composer need to know when the open thread belongs to a group: the group, and a face for every
// member (a retired member's old messages keep theirs). ThreadView provides it (null everywhere else).
import { createContext, createElement, useContext, type ReactNode } from "react";

import type { GroupMember, GroupWire } from "./groupModel";

export interface GroupThreadInfo {
  readonly group: GroupWire;
  readonly membersById: ReadonlyMap<string, GroupMember>;
}

const Ctx = createContext<GroupThreadInfo | null>(null);

export function GroupThreadProvider(props: {
  readonly value: GroupThreadInfo | null;
  readonly children: ReactNode;
}) {
  return createElement(Ctx.Provider, { value: props.value }, props.children);
}

/** The group of the active thread, or null (single-blob, Chat and Code threads). */
export function useGroupThread(): GroupThreadInfo | null {
  return useContext(Ctx);
}
