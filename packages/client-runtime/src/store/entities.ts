import {
  HostId,
  ProjectId,
  ThreadId,
  type HostProjectRef,
  type HostThreadRef,
} from "@kora/contracts";
import * as Schema from "effect/Schema";

// Scoped references become strings so they can key atom families. The NUL separator cannot
// appear in a host id, so only the first one splits; the id after it can be anything.
const SEPARATOR = "\u0000";

export class InvalidScopedProjectKeyError extends Schema.TaggedError<InvalidScopedProjectKeyError>()(
  "InvalidScopedProjectKeyError",
  { key: Schema.String },
) {
  override get message() {
    return "Invalid scoped project atom key: " + JSON.stringify(this.key) + ".";
  }
}

export class InvalidScopedThreadKeyError extends Schema.TaggedError<InvalidScopedThreadKeyError>()(
  "InvalidScopedThreadKeyError",
  { key: Schema.String },
) {
  override get message() {
    return "Invalid scoped thread atom key: " + JSON.stringify(this.key) + ".";
  }
}

export class InvalidScopedProjectRefCollectionKeyError extends Schema.TaggedError<InvalidScopedProjectRefCollectionKeyError>()(
  "InvalidScopedProjectRefCollectionKeyError",
  { key: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return (
      "Invalid scoped project reference collection atom key: " + JSON.stringify(this.key) + "."
    );
  }
}

export function projectKey(ref: HostProjectRef): string {
  return `${ref.hostId}${SEPARATOR}${ref.projectId}`;
}

export function threadKey(ref: HostThreadRef): string {
  return `${ref.hostId}${SEPARATOR}${ref.threadId}`;
}

export function projectRefCollectionKey(refs: ReadonlyArray<HostProjectRef>): string {
  return JSON.stringify(refs.map((ref) => [ref.hostId, ref.projectId]));
}

const splitKey = (key: string): readonly [string, string] | null => {
  const at = key.indexOf(SEPARATOR);
  return at === -1 ? null : [key.slice(0, at), key.slice(at + 1)];
};

export function parseProjectKey(key: string): HostProjectRef {
  const parts = splitKey(key);
  if (parts === null) throw new InvalidScopedProjectKeyError({ key });
  return { hostId: HostId.make(parts[0]), projectId: ProjectId.make(parts[1]) };
}

const ProjectRefPairs = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));
const decodeProjectRefPairs = Schema.decodeUnknownSync(Schema.fromJsonString(ProjectRefPairs));

export function parseProjectRefCollectionKey(key: string): ReadonlyArray<HostProjectRef> {
  try {
    return decodeProjectRefPairs(key).map(([hostId, projectId]) => ({
      hostId: HostId.make(hostId),
      projectId: ProjectId.make(projectId),
    }));
  } catch (cause) {
    throw new InvalidScopedProjectRefCollectionKeyError({ key, cause });
  }
}

export function parseThreadKey(key: string): HostThreadRef {
  const parts = splitKey(key);
  if (parts === null) throw new InvalidScopedThreadKeyError({ key });
  return { hostId: HostId.make(parts[0]), threadId: ThreadId.make(parts[1]) };
}

type ProjectRefs = ReadonlyArray<HostProjectRef>;
type ThreadRefs = ReadonlyArray<HostThreadRef>;

export const projectRefsEqual = (left: ProjectRefs, right: ProjectRefs): boolean =>
  left.length === right.length &&
  left.every(
    (ref, at) => right[at]!.hostId === ref.hostId && right[at]!.projectId === ref.projectId,
  );

export const threadRefsEqual = (left: ThreadRefs, right: ThreadRefs): boolean =>
  left.length === right.length &&
  left.every((ref, at) => right[at]!.hostId === ref.hostId && right[at]!.threadId === ref.threadId);

export function arrayElementsEqual<A>(left: ReadonlyArray<A>, right: ReadonlyArray<A>): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
