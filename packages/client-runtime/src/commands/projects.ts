import type { HostId, ScmHostKind, ScmRepositoryInfo } from "@kora/contracts";

export type AddProjectRemoteHostKind = Extract<
  ScmHostKind,
  "github" | "gitlab" | "forgejo" | "bitbucket" | "azure-devops"
>;
export type AddProjectRemoteSource = AddProjectRemoteHostKind | "url";

type SourceReadiness = { readonly hint: string | null; readonly ready: boolean };

export type AddProjectRemoteSourceReadiness = Record<AddProjectRemoteSource, SourceReadiness>;

export type AddProjectCloneFlow =
  | {
      readonly source: AddProjectRemoteSource;
      readonly hostId: HostId;
      readonly step: "repository";
    }
  | {
      readonly step: "confirm";
      readonly hostId: HostId;
      readonly source: AddProjectRemoteSource;
      readonly repositoryInput: string;
      readonly repository: ScmRepositoryInfo | null;
      readonly remoteUrl: string;
    };
