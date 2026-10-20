export type UpdatePublishConfig =
  | { provider: "github"; owner: string; repo: string; releaseType: "release" }
  | { provider: "generic"; url: string };
export function updatePublishConfig(feed: string | undefined): UpdatePublishConfig | null;

export interface WinSigning {
  mode: "azure" | "pfx" | "none";
  force: boolean;
  win: Record<string, unknown>;
}
export function winSigning(env: Record<string, string | undefined>): WinSigning;

export function updateFeedFiles(names: ReadonlyArray<string>): string[];

/** Why a build may not carry an update feed (unsigned, or no publisher name), or null. */
export function updateFeedRefusal(
  publish: Record<string, unknown> | null,
  signing: WinSigning,
): string | null;
