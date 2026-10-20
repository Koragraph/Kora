import * as Schema from "effect/Schema";

import { CountingNumber, NonblankString } from "./primitives.ts";

export const ScmHostKind = Schema.Literals([
  "github",
  "gitlab",
  "forgejo",
  "azure-devops",
  "bitbucket",
  "unknown",
]);
export type ScmHostKind = Schema.Schema.Type<typeof ScmHostKind>;

export const ScmHostInfo = Schema.Struct({
  kind: ScmHostKind,
  name: NonblankString,
  baseUrl: Schema.String,
});
export type ScmHostInfo = Schema.Schema.Type<typeof ScmHostInfo>;

export const ChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
export type ChangeRequestState = (typeof ChangeRequestState)["Type"];

export const ChangeRequest = Schema.Struct({
  provider: ScmHostKind,
  number: CountingNumber,
  title: NonblankString,
  url: Schema.String,
  baseRefName: NonblankString,
  headRefName: NonblankString,
  state: ChangeRequestState,
  // Present when the provider can tell that an open request is a draft.
  isDraft: Schema.optionalKey(Schema.Boolean),
  closedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  updatedAt: Schema.Option(Schema.DateTimeUtc),
  isCrossRepository: Schema.optionalKey(Schema.Boolean),
  headRepositoryNameWithOwner: Schema.optionalKey(Schema.NullOr(NonblankString)),
  headRepositoryOwnerLogin: Schema.optionalKey(Schema.NullOr(NonblankString)),
});
export type ChangeRequest = Schema.Schema.Type<typeof ChangeRequest>;

export const ScmCloneProtocol = Schema.Literals(["auto", "ssh", "https"]);
export type ScmCloneProtocol = Schema.Schema.Type<typeof ScmCloneProtocol>;

export const ScmRepositoryInfo = Schema.Struct({
  provider: ScmHostKind,
  nameWithOwner: NonblankString,
  url: NonblankString,
  sshUrl: NonblankString,
});
export type ScmRepositoryInfo = Schema.Schema.Type<typeof ScmRepositoryInfo>;

export class ScmHostError extends Schema.TaggedError<ScmHostError>()("ScmHostError", {
  provider: ScmHostKind,
  cause: Schema.optional(Schema.Defect()),
  detail: Schema.String,
  reference: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  cwd: Schema.String,
  operation: Schema.String,
}) {
  override get message() {
    return (
      "Source control provider " +
      this.provider +
      " failed in " +
      this.operation +
      ": " +
      this.detail
    );
  }
}
